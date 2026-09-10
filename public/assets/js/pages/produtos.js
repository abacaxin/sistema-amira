import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml } from "../ui.js";
import {
  db, collection, getDocs, query,
  doc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} from "../db.js";
import { brl, parseNum } from "../money.js";
import { infoPreco, estoquePorModo, filtrosDoProduto } from "../produtos-schema.js";
import { listarCamadas, camadaPrincipal } from "../camadas.js";

// Editor completo — grava na MESMA colecao `produtos` do site, no mesmo
// formato do admin do site (frontend/src/pages/admin/js/admin-produtos.js):
// precoVarejo/precoAtacado, estoqueVarejo/estoqueAtacado, filtros{} por camada,
// categoria (legado = 1a opcao da camada principal), desconto opcional.
// Foto: upload de arquivo -> data URI comprimida (mesmo esquema do admin do
// site; sem Firebase Storage). Produtos legados com imagemURL http continuam
// funcionando ate a foto ser trocada.

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "produtos" });

let produtos = [];
let camadas = [];
let camadaPrincipalSlug = null;

root.innerHTML = `
  <div class="card">
    <div class="row">
      <input id="busca" placeholder="Buscar por nome, SKU ou codigo de barras">
      <select id="fativo">
        <option value="">Todos</option>
        <option value="sim">Ativos</option>
        <option value="nao">Inativos</option>
      </select>
      <button class="btn" id="novo">+ Produto</button>
    </div>
  </div>
  <div class="card">
    <div class="row" style="align-items:center">
      <span class="muted" style="flex:0 0 auto">Acao em massa (selecionados):</span>
      <button class="btn sec" id="ativar" style="flex:0 0 auto">Ativar</button>
      <button class="btn sec" id="inativar" style="flex:0 0 auto">Inativar</button>
    </div>
  </div>
  <div class="card"><div id="tabela">Carregando...</div></div>`;

document.getElementById("busca").oninput = renderTabela;
document.getElementById("fativo").onchange = renderTabela;
document.getElementById("novo").onclick = () => editar(null);
document.getElementById("ativar").onclick = () => aplicarMassa(true);
document.getElementById("inativar").onclick = () => aplicarMassa(false);

await carregar();

async function carregar() {
  [camadas, produtos] = await Promise.all([
    listarCamadas().catch(() => []),
    getDocs(query(collection(db, "produtos"))).then((s) =>
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
    ),
  ]);
  camadaPrincipalSlug = camadaPrincipal(camadas)?.slug || null;
  produtos.sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
  renderTabela();
}

function rotuloPrincipal(p) {
  const slugs = camadaPrincipalSlug ? (filtrosDoProduto(p, camadaPrincipalSlug)[camadaPrincipalSlug] || []) : [];
  const principal = camadaPrincipal(camadas);
  if (!principal || slugs.length === 0) return "";
  return slugs.map((s) => principal.opcoes.find((o) => o.slug === s)?.nome || s).join(", ");
}

function renderTabela() {
  const termo = (document.getElementById("busca").value || "").toLowerCase().trim();
  const fativo = document.getElementById("fativo").value;
  const lista = produtos.filter((p) => {
    if (termo &&
      !(p.nome || "").toLowerCase().includes(termo) &&
      !(p.sku || "").toLowerCase().includes(termo) &&
      !(p.codigoBarras || "").toLowerCase().includes(termo)) return false;
    if (fativo === "sim" && p.ativo === false) return false;
    if (fativo === "nao" && p.ativo !== false) return false;
    return true;
  });

  document.getElementById("tabela").innerHTML = `
    <table>
      <thead><tr>
        <th><input type="checkbox" id="chk-all" style="width:auto"></th>
        <th>Nome</th><th>Cod. barras</th><th>${escapeHtml(camadaPrincipal(camadas)?.nome || "Filtro")}</th>
        <th class="right">Varejo</th><th class="right">Est. varejo</th><th class="right">Est. atac.</th>
        <th>Ativo</th><th></th>
      </tr></thead>
      <tbody>
        ${
          lista
            .map(
              (p) => `<tr>
                <td><input type="checkbox" class="chk" data-id="${p.id}" style="width:auto"></td>
                <td>${escapeHtml(p.nome || "")}</td>
                <td>${escapeHtml(p.codigoBarras || "")}</td>
                <td>${escapeHtml(rotuloPrincipal(p))}</td>
                <td class="right">${brl(infoPreco(p, "varejo").precoFinal)}</td>
                <td class="right">${estoquePorModo(p, "varejo")}</td>
                <td class="right">${estoquePorModo(p, "atacado")}</td>
                <td><span class="tag ${p.ativo === false ? "inativo" : "ativo"}">${p.ativo === false ? "inativo" : "ativo"}</span></td>
                <td class="right"><button class="btn ghost editar" data-id="${p.id}">Editar</button></td>
              </tr>`
            )
            .join("") || `<tr><td colspan="9" class="muted">Nenhum produto.</td></tr>`
        }
      </tbody>
    </table>`;

  document.querySelectorAll(".editar").forEach(
    (b) => (b.onclick = () => editar(produtos.find((p) => p.id === b.dataset.id)))
  );
  const all = document.getElementById("chk-all");
  if (all) all.onchange = (e) =>
    document.querySelectorAll(".chk").forEach((c) => (c.checked = e.target.checked));
}

// ── Foto do produto: upload de arquivo -> data URI comprimida ───────────
// Sem Firebase Storage (plano Spark): a foto e redimensionada num <canvas>
// e salva como data URI dentro do proprio doc do produto (igual ao admin do
// site). O Firestore limita 1 MB/doc, entao a compressao e agressiva.
const ALVO_BYTES_FOTO = 300 * 1024;

function lerArquivoComoDataURL(arquivo) {
  return new Promise((resolve, reject) => {
    if (!arquivo || !arquivo.type.startsWith("image/")) {
      reject(new Error("Escolha um arquivo de imagem (JPG, PNG, WEBP...)."));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
    fr.readAsDataURL(arquivo);
  });
}

function redimensionar(dataURL, maxLado, qualidade) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const maior = Math.max(width, height);
      if (maior > maxLado) {
        const escala = maxLado / maior;
        width = Math.round(width * escala);
        height = Math.round(height * escala);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // PNG transparente -> JPEG com fundo branco
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", qualidade));
    };
    img.onerror = () => reject(new Error("Imagem invalida ou corrompida."));
    img.src = dataURL;
  });
}

async function comprimirFoto(arquivo) {
  const bruto = await lerArquivoComoDataURL(arquivo);
  const tentativas = [[1100, 0.72], [950, 0.62], [800, 0.55], [640, 0.5]];
  let saida = await redimensionar(bruto, 1100, 0.72);
  for (const [lado, q] of tentativas) {
    if (saida.length <= ALVO_BYTES_FOTO * 1.37) break; // 1.37 ~= overhead do base64
    saida = await redimensionar(bruto, lado, q);
  }
  return saida;
}

function editar(p) {
  let imagemAtual = p?.imagemURL || "";
  const camadasHtml = camadas.length
    ? camadas
        .map((cam, i) => {
          const marcadas = filtrosDoProduto(p || {}, camadaPrincipalSlug)[cam.slug] || [];
          return `<fieldset style="border:1px solid var(--linha,#ddd);border-radius:8px;padding:8px;margin:6px 0">
            <legend>${escapeHtml(cam.nome)}${i === 0 ? " <span class='tag ativo'>principal</span>" : ""}</legend>
            ${
              cam.opcoes.length
                ? cam.opcoes
                    .map(
                      (op) => `<label style="text-transform:none;display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0">
                        <input type="checkbox" data-camada="${escapeHtml(cam.slug)}" value="${escapeHtml(op.slug)}" ${marcadas.includes(op.slug) ? "checked" : ""} style="width:auto">
                        ${escapeHtml(op.nome)}</label>`
                    )
                    .join("")
                : `<span class="muted">Sem opcoes nesta camada.</span>`
            }
          </fieldset>`;
        })
        .join("")
    : `<p style="color:var(--warn)">As camadas de filtro nao carregaram. Voce ainda pode editar nome, preco, estoque e foto &mdash; a classificacao atual do produto (categoria/filtros) sera <strong>preservada</strong>. Cadastre/ajuste as camadas em "Camadas de filtro" no admin do site.</p>`;

  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="f-nome" value="${escapeHtml(p?.nome || "")}">
    <label>Codigo de barras (EAN) &mdash; obrigatorio</label>
    <input id="f-ean" inputmode="numeric" value="${escapeHtml(p?.codigoBarras || "")}" placeholder="Bipe o produto ou digite o EAN">
    <label>Descricao</label><textarea id="f-desc" rows="2">${escapeHtml(p?.descricao || "")}</textarea>
    <label>Foto do produto</label>
    <div class="row" style="align-items:center;gap:10px">
      <div id="f-img-preview" style="width:72px;height:72px;flex:0 0 auto;border-radius:8px;border:1px solid var(--linha,#ddd);background:#fff center/contain no-repeat"></div>
      <label class="btn sec" style="flex:0 0 auto;cursor:pointer">
        <span id="f-img-txt">Escolher foto</span>
        <input type="file" id="f-img" accept="image/*" hidden>
      </label>
      <button type="button" class="btn ghost" id="f-img-rm" style="flex:0 0 auto">Remover</button>
    </div>
    <p class="muted" id="f-img-msg" style="margin:4px 0 0">Redimensionada e salva junto com o produto (sem link externo).</p>
    <div class="row">
      <div><label>Preco varejo</label><input id="f-pv" value="${p?.precoVarejo ?? ""}"></div>
      <div><label>Preco atacado</label><input id="f-pa" value="${p?.precoAtacado ?? ""}"></div>
      <div><label>Peso (g)</label><input id="f-peso" type="number" value="${p?.peso ?? 0}"></div>
    </div>
    <div class="row">
      <div><label>Estoque varejo</label><input id="f-ev" type="number" value="${p ? estoquePorModo(p, "varejo") : 0}"></div>
      <div><label>Estoque atacado</label><input id="f-ea" type="number" value="${p ? estoquePorModo(p, "atacado") : 0}"></div>
    </div>
    <label>Camadas de filtro</label>
    ${camadasHtml}
    <div class="row">
      <label style="text-transform:none"><input type="checkbox" id="f-ativo" ${p?.ativo === false ? "" : "checked"} style="width:auto"> Ativo (visivel na loja)</label>
      <label style="text-transform:none"><input type="checkbox" id="f-destaque" ${p?.destaque === true ? "checked" : ""} style="width:auto"> Destaque na home</label>
      <label style="text-transform:none"><input type="checkbox" id="f-frete" ${p?.freteDisponivel === false ? "" : "checked"} style="width:auto"> Tem entrega</label>
    </div>
    <div class="row">
      <label style="text-transform:none"><input type="checkbox" id="f-desc-on" ${p?.descontoAtivo === true ? "checked" : ""} style="width:auto"> Desconto ativo</label>
      <div><label>Desconto (%) 1&ndash;90</label><input id="f-desc-pct" value="${p?.descontoPercentual ?? ""}"></div>
    </div>
    ${p ? `<button class="btn danger" id="f-del" style="margin-top:14px">Excluir produto</button>` : ""}`;

  // Foto: upload -> data URI. `imagemAtual` guarda o valor corrente (data URI
  // novo ou imagemURL legado); so muda quando a pessoa escolhe/remove.
  const imgInput = c.querySelector("#f-img");
  const imgPreview = c.querySelector("#f-img-preview");
  const imgTxt = c.querySelector("#f-img-txt");
  const imgRm = c.querySelector("#f-img-rm");
  const imgMsg = c.querySelector("#f-img-msg");

  function pintarPreview() {
    imgPreview.style.backgroundImage = imagemAtual ? `url("${imagemAtual}")` : "";
    imgTxt.textContent = imagemAtual ? "Trocar foto" : "Escolher foto";
    imgRm.style.display = imagemAtual ? "" : "none";
  }
  pintarPreview();

  imgInput.onchange = async () => {
    const arq = imgInput.files && imgInput.files[0];
    if (!arq) return;
    imgTxt.textContent = "Processando...";
    imgMsg.textContent = "Comprimindo imagem...";
    try {
      imagemAtual = await comprimirFoto(arq);
      imgMsg.textContent = `Pronta (${Math.round(imagemAtual.length / 1024)} KB).`;
    } catch (e) {
      imgMsg.textContent = e.message || "Nao foi possivel processar a imagem.";
    } finally {
      imgInput.value = "";
      pintarPreview();
    }
  };
  imgRm.onclick = () => { imagemAtual = ""; imgMsg.textContent = "Sem foto."; pintarPreview(); };

  const bg = modal({
    titulo: p ? "Editar produto" : "Novo produto",
    corpo: c,
    onConfirmar: async () => {
      const filtros = {};
      c.querySelectorAll('input[type="checkbox"][data-camada]:checked').forEach((cb) => {
        (filtros[cb.dataset.camada] ||= []).push(cb.value);
      });
      const categoriaLegado = (camadaPrincipalSlug && filtros[camadaPrincipalSlug]?.[0]) || "";

      const descontoAtivo = c.querySelector("#f-desc-on").checked;
      const descontoPercentual = parseNum(c.querySelector("#f-desc-pct").value);
      const precoVarejo = parseNum(c.querySelector("#f-pv").value);
      const precoAtacado = parseNum(c.querySelector("#f-pa").value);
      const estoqueAtacado = Math.trunc(parseNum(c.querySelector("#f-ea").value));

      // Se as camadas nao carregaram, um produto existente NAO tem a
      // classificacao mexida (evita zerar filtros/categoria no site num save
      // que so queria trocar preco/estoque/foto). Produto novo entra sem
      // classificacao mesmo — o admin ajusta depois no site.
      const semCamadas = camadas.length === 0;
      const dados = {
        nome: c.querySelector("#f-nome").value.trim(),
        codigoBarras: c.querySelector("#f-ean").value.trim(),
        descricao: c.querySelector("#f-desc").value.trim(),
        imagemURL: imagemAtual,
        ...(semCamadas
          ? (p ? {} : { filtros: {}, categoria: "" })
          : { filtros, categoria: categoriaLegado }),
        peso: Math.trunc(parseNum(c.querySelector("#f-peso").value)),
        precoVarejo,
        precoAtacado: precoAtacado > 0 ? precoAtacado : null,
        estoqueVarejo: Math.trunc(parseNum(c.querySelector("#f-ev").value)),
        estoqueAtacado,
        estoque: null,
        descontoAtivo,
        descontoTipo: descontoAtivo ? "percentual" : null,
        descontoPercentual: descontoAtivo ? descontoPercentual : null,
        freteDisponivel: c.querySelector("#f-frete").checked,
        ativo: c.querySelector("#f-ativo").checked,
        destaque: c.querySelector("#f-destaque").checked,
        atualizadoEm: serverTimestamp(),
      };

      if (!dados.nome) { toast("Nome e obrigatorio.", "err"); return false; }
      if (!/^\d{8,14}$/.test(dados.codigoBarras)) {
        toast("Codigo de barras (EAN) obrigatorio: 8 a 14 digitos.", "err"); return false;
      }
      const dup = produtos.find((x) => (x.codigoBarras || "") === dados.codigoBarras && x.id !== p?.id);
      if (dup) { toast(`Codigo de barras ja usado por "${dup.nome}".`, "err"); return false; }
      if (camadaPrincipalSlug && !(filtros[camadaPrincipalSlug]?.length)) {
        toast("Marque ao menos uma opcao na camada principal.", "err"); return false;
      }
      if ((dados.precoVarejo || 0) <= 0 && (dados.precoAtacado || 0) <= 0) {
        toast("Configure pelo menos preco de varejo e/ou de atacado.", "err"); return false;
      }
      if ((dados.precoAtacado || 0) > 0 && estoqueAtacado <= 0) {
        toast("Preco de atacado exige estoque de atacado (ou zere o preco de atacado).", "err"); return false;
      }
      if (descontoAtivo && (descontoPercentual < 1 || descontoPercentual > 90)) {
        toast("Desconto deve ser um percentual entre 1 e 90.", "err"); return false;
      }

      if (p) {
        await updateDoc(doc(db, "produtos", p.id), dados);
      } else {
        await addDoc(collection(db, "produtos"), {
          ...dados,
          imagensExtras: [],
          criadoEm: serverTimestamp(),
        });
      }
      toast("Produto salvo.", "ok");
      carregar();
    },
  });

  if (p)
    c.querySelector("#f-del").onclick = async () => {
      if (!(await confirmar(`Excluir "${p.nome}"? Esta acao nao pode ser desfeita.`))) return;
      await deleteDoc(doc(db, "produtos", p.id));
      bg.remove();
      toast("Produto excluido.", "ok");
      carregar();
    };
}

async function aplicarMassa(ativo) {
  const ids = [...document.querySelectorAll(".chk:checked")].map((c) => c.dataset.id);
  if (!ids.length) return toast("Selecione ao menos um produto.", "warn");
  if (!(await confirmar(`${ativo ? "Ativar" : "Inativar"} ${ids.length} produto(s)?`))) return;
  const batch = writeBatch(db);
  ids.forEach((id) => batch.update(doc(db, "produtos", id), { ativo, atualizadoEm: serverTimestamp() }));
  await batch.commit();
  toast("Feito.", "ok");
  carregar();
}
