import { requireAuth } from "../auth.js";
import { initShell, toast, escapeHtml } from "../ui.js";
import { auth } from "../firebase.js";
import { db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "../db.js";
import { parseNum } from "../money.js";
import { FORMAS_JUROS } from "../juros.js";
import { criarClientePoint } from "../point.js";

const BASES = ["total", "total_sem_desconto", "margem"];
const FORMA_LABEL = { credito: "Crédito", crediario: "Crediário", debito: "Débito" };

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "config" });

const [snapSis, snapInd] = await Promise.all([
  getDoc(doc(db, "configuracoes", "sistema")),
  getDoc(doc(db, "configuracoes", "indicadores")),
]);
const cfg = snapSis.exists() ? snapSis.data() : {};
const com = cfg.comissao || {};
const parc = cfg.parcelamento || {};
const point = cfg.point || {};
const ind = snapInd.exists() ? snapInd.data() : {};

root.innerHTML = `
  <div class="card">
    <strong>Configuracoes do sistema interno</strong>
    <p class="muted">O catalogo, os precos e o estoque sao os do site (mesma base). Aqui ficam so os ajustes internos.</p>
    <label>Nome da loja (recibo)</label>
    <input id="nome" value="${escapeHtml(cfg.nome_loja ?? "Amira")}">
    <label>CNPJ</label>
    <input id="cnpj" value="${escapeHtml(cfg.cnpj ?? "")}">
    <label>Formas de pagamento do PDV (separadas por virgula)</label>
    <input id="formas" value="${escapeHtml((cfg.formas_pagamento ?? ["dinheiro", "pix", "debito", "credito"]).join(", "))}">
    <div class="row">
      <div>
        <label>Base padrao da comissao (vendedor)</label>
        <select id="base">
          ${BASES.map((b) => `<option ${b === (com.base || "total") ? "selected" : ""}>${b}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Percentual padrao (%)</label>
        <input id="pct" value="${com.percentual_padrao ?? 0}">
      </div>
    </div>
    <p class="muted">Base "total" = sobre o valor final pago. "total_sem_desconto" = sobre os itens a preco cheio. "margem" = (venda - custo); o catalogo do site nao guarda custo, entao "margem" fica em 0 ate existir esse campo.</p>
    <button class="btn" id="salvar" style="margin-top:8px">Salvar</button>
  </div>

  <div class="card">
    <strong>Parcelamento e juros do PDV</strong>
    <p class="muted">Ao escolher "credito" ou "crediario" no pagamento do PDV, o vendedor pode parcelar (debito nunca parcela). Aqui voce define ate quantas vezes, o valor minimo de cada parcela, e os juros de cada forma.</p>
    <div class="row">
      <div><label>Maximo de parcelas</label><input id="parc-max" value="${parc.maximo ?? 12}"></div>
      <div><label>Valor minimo por parcela (R$)</label><input id="parc-min" value="${parc.minimo_parcela ?? 0}"></div>
    </div>
    <p class="muted">Uma linha por quantidade de parcelas. <strong>Cliente</strong> e o juros somado ao valor que o cliente paga nessa forma; <strong>loja</strong> e o custo da loja (ex.: taxa da maquininha) sobre o valor original — os dois sao independentes, nao precisam ser iguais. Quantidade sem linha = sem juros nem custo.</p>

    <label>Juros no Crédito</label>
    <div class="juros-linhas" id="juros-linhas-credito"></div>
    <button type="button" class="btn ghost" id="add-parcela-credito" style="margin-top:6px">+ Adicionar parcela</button>

    <label style="margin-top:20px">Juros no Crediário</label>
    <div class="juros-linhas" id="juros-linhas-crediario"></div>
    <button type="button" class="btn ghost" id="add-parcela-crediario" style="margin-top:6px">+ Adicionar parcela</button>

    <label style="margin-top:20px">Juros no Débito</label>
    <p class="muted" style="margin:-2px 0 6px">Debito nunca parcela — so a taxa a vista.</p>
    <div class="juros-linhas" id="juros-linhas-debito"></div>

    <button class="btn" id="salvar-parc" style="margin-top:16px">Salvar parcelamento</button>
  </div>

  <div class="card">
    <strong>Maquininha (Mercado Pago Point)</strong>
    <p class="muted">Cobra crédito e débito direto na maquininha pelo PDV e traz a taxa real de cada venda. Precisa da API (Vercel) no ar e da maquininha em modo PDV — passo a passo no README, seção "Maquininha Mercado Pago Point".</p>
    <label style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink)"><input type="checkbox" id="point-ativo" ${point.ativo === true ? "checked" : ""} style="width:auto"> Usar a maquininha no PDV (botão "Cobrar na maquininha")</label>
    <label style="text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink)"><input type="checkbox" id="point-obrigatorio" ${point.obrigatorio === true ? "checked" : ""} style="width:auto"> Exigir a maquininha em crédito e débito (não deixa registrar cartão manualmente)</label>
    <label>URL da API (deixe vazio se a API estiver no mesmo domínio do sistema)</label>
    <input id="point-api" value="${escapeHtml(point.api_url ?? "")}" placeholder="https://sistema-amira-api.vercel.app">
    <div class="row" style="margin-top:12px">
      <div style="flex:0 0 auto"><button class="btn" id="salvar-point">Salvar maquininha</button></div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="testar-point">Testar conexão</button></div>
    </div>
    <div id="point-terminais" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <strong>Comissao de indicadores (link ?ref= no site)</strong>
    <p class="muted">Compra feita pelo link de um indicador gera comissao sobre o total dos itens elegiveis. Pagamento e manual. O link do indicador nao tem prazo de validade.</p>
    <label>URL do site (para montar o link)</label>
    <input id="ind-site" value="${escapeHtml(ind.site_url ?? "")}" placeholder="https://flora-5754a.web.app">
    <label>Percentual (%)</label>
    <input id="ind-pct" value="${ind.percentual ?? 5}">
    <label>Slugs de categoria que NAO geram comissao (separados por virgula)</label>
    <input id="ind-cat" value="${escapeHtml((ind.categorias_excluidas ?? ["iphones"]).join(", "))}">
    <p class="muted">No site, iPhone e a opcao da camada principal cujo slug comeca com <code>iphone</code>. O prefixo "iphone" ja e reconhecido automaticamente; liste aqui outros slugs a excluir, se houver.</p>
    <button class="btn" id="salvar-ind" style="margin-top:8px">Salvar indicadores</button>
  </div>`;

// ── Juros por parcela: uma linha por quantidade, editavel/removivel na hora
// (credito/crediario) — debito fica fixo em "a vista" (nunca parcela de
// verdade, so tem sentido a taxa em 1x). Le/grava sempre o objeto
// {parcelas: {cliente, loja}} direto, sem passar por formato de texto.
function linhaJurosHtml(parcela, taxas, removivel) {
  return `
    <div class="cart-line juros-linha">
      ${
        removivel
          ? `<input type="number" min="1" step="1" class="jl-parcela" value="${parcela}" aria-label="Numero de parcelas" style="width:56px">`
          : `<input type="number" value="1" disabled class="jl-parcela" aria-label="Debito e sempre a vista" style="width:56px">`
      }
      <span class="muted">x &middot; cliente</span>
      <input type="number" min="0" step="0.01" class="jl-cliente" value="${Number(taxas?.cliente) || 0}" aria-label="Juros do cliente, em porcentagem">
      <span class="muted">% &middot; loja</span>
      <input type="number" min="0" step="0.01" class="jl-loja" value="${Number(taxas?.loja) || 0}" aria-label="Custo da loja, em porcentagem">
      <span class="muted">%</span>
      ${removivel ? `<button type="button" class="btn ghost jl-remover" aria-label="Remover esta parcela">&times;</button>` : ""}
    </div>`;
}

function ligarRemocao(forma) {
  document.querySelectorAll(`#juros-linhas-${forma} .jl-remover`).forEach((b) => {
    b.onclick = () => {
      b.closest(".juros-linha").remove();
      if (!document.querySelector(`#juros-linhas-${forma} .juros-linha`))
        document.getElementById(`juros-linhas-${forma}`).innerHTML = `<p class="muted">Nenhuma parcela configurada.</p>`;
    };
  });
}

function montarLinhasForma(forma) {
  const container = document.getElementById(`juros-linhas-${forma}`);
  const tabela = parc.juros?.[forma] || {};
  if (forma === "debito") {
    container.innerHTML = linhaJurosHtml(1, tabela["1"], false);
    return;
  }
  const parcelas = Object.keys(tabela).map(Number).sort((a, b) => a - b);
  container.innerHTML = parcelas.length
    ? parcelas.map((p) => linhaJurosHtml(p, tabela[String(p)], true)).join("")
    : `<p class="muted">Nenhuma parcela configurada.</p>`;
  ligarRemocao(forma);
}

montarLinhasForma("credito");
montarLinhasForma("crediario");
montarLinhasForma("debito");

for (const forma of ["credito", "crediario"]) {
  document.getElementById(`add-parcela-${forma}`).onclick = () => {
    const container = document.getElementById(`juros-linhas-${forma}`);
    container.querySelector("p.muted")?.remove();
    const existentes = container.querySelectorAll(".jl-parcela");
    const proxima = Array.from(existentes).reduce((m, inp) => Math.max(m, Math.trunc(+inp.value) || 0), 0) + 1;
    container.insertAdjacentHTML("beforeend", linhaJurosHtml(proxima, { cliente: 0, loja: 0 }, true));
    ligarRemocao(forma);
    const novas = container.querySelectorAll(".jl-parcela");
    novas[novas.length - 1].focus();
  };
}

/** Le as linhas da tela e monta {parcelas: {cliente, loja}} pra essa forma. */
function lerTabelaDaTela(forma) {
  const tabela = {};
  let duplicada = false;
  document.querySelectorAll(`#juros-linhas-${forma} .juros-linha`).forEach((linha) => {
    const parcela = Math.max(1, Math.trunc(parseNum(linha.querySelector(".jl-parcela").value)) || 1);
    const cliente = Math.max(0, parseNum(linha.querySelector(".jl-cliente").value));
    const loja = Math.max(0, parseNum(linha.querySelector(".jl-loja").value));
    if (tabela[String(parcela)]) duplicada = true;
    tabela[String(parcela)] = { cliente, loja };
  });
  return { tabela, duplicada };
}

document.getElementById("salvar").onclick = async () => {
  await setDoc(
    doc(db, "configuracoes", "sistema"),
    {
      nome_loja: document.getElementById("nome").value.trim(),
      cnpj: document.getElementById("cnpj").value.trim(),
      formas_pagamento: document
        .getElementById("formas")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      comissao: {
        base: document.getElementById("base").value,
        percentual_padrao: parseNum(document.getElementById("pct").value),
      },
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
  toast("Configuracoes salvas.", "ok");
};

document.getElementById("salvar-parc").onclick = async () => {
  // updateDoc com caminhos pontilhados (nao setDoc({merge:true})): merge do
  // Firestore em mapa aninhado e RECURSIVO — ele so sobrescreveria as chaves
  // novas, e uma parcela removida da tela continuaria existindo no banco.
  // Caminho pontilhado substitui o mapa daquela forma por inteiro.
  const dados = {
    "parcelamento.maximo": Math.max(1, Math.trunc(parseNum(document.getElementById("parc-max").value)) || 12),
    "parcelamento.minimo_parcela": Math.max(0, parseNum(document.getElementById("parc-min").value)),
    atualizadoEm: serverTimestamp(),
  };
  for (const forma of FORMAS_JUROS) {
    const { tabela, duplicada } = lerTabelaDaTela(forma);
    if (duplicada) return toast(`Ha parcelas repetidas em "${FORMA_LABEL[forma]}" — corrija antes de salvar.`, "err");
    dados[`parcelamento.juros.${forma}`] = tabela;
  }

  try {
    await updateDoc(doc(db, "configuracoes", "sistema"), dados);
  } catch (_) {
    // Doc "sistema" pode nao existir ainda (primeira configuracao) —
    // updateDoc falha em doc inexistente; cria com setDoc nesse caso.
    await setDoc(
      doc(db, "configuracoes", "sistema"),
      {
        parcelamento: {
          maximo: dados["parcelamento.maximo"],
          minimo_parcela: dados["parcelamento.minimo_parcela"],
          juros: Object.fromEntries(FORMAS_JUROS.map((f) => [f, dados[`parcelamento.juros.${f}`]])),
        },
        atualizadoEm: serverTimestamp(),
      },
      { merge: true }
    );
  }
  toast("Parcelamento salvo.", "ok");
};

// ── Maquininha Point ─────────────────────────────────────────────────────
document.getElementById("salvar-point").onclick = async () => {
  const dados = {
    ativo: document.getElementById("point-ativo").checked,
    obrigatorio: document.getElementById("point-obrigatorio").checked,
    api_url: document.getElementById("point-api").value.trim().replace(/\/+$/, ""),
  };
  // merge recursivo do Firestore e ok aqui: sao so 3 escalares dentro de `point`
  await setDoc(doc(db, "configuracoes", "sistema"), { point: dados, atualizadoEm: serverTimestamp() }, { merge: true });
  toast("Maquininha salva.", "ok");
};

// Testa com a URL que esta no campo (nao a salva) — da pra conferir antes de gravar.
function clientePointDaTela() {
  return criarClientePoint({
    apiBase: document.getElementById("point-api").value.trim(),
    obterToken: () => auth.currentUser.getIdToken(),
  });
}

async function listarTerminais() {
  const box = document.getElementById("point-terminais");
  box.innerHTML = `<p class="muted">Consultando o Mercado Pago…</p>`;
  try {
    const r = await clientePointDaTela().terminais();
    if (!r.terminais.length) {
      box.innerHTML = `<p class="muted">Conexão ok, mas o Mercado Pago não listou nenhum terminal nessa conta. Vincule a maquininha pelo app do Mercado Pago (loja + caixa) e tente de novo.</p>`;
      return;
    }
    box.innerHTML = `
      <p class="muted">${
        r.configurado
          ? `Terminal configurado no servidor (<code>MP_POINT_TERMINAL_ID</code>): <code>${escapeHtml(r.configurado)}</code>`
          : `O servidor ainda não tem <code>MP_POINT_TERMINAL_ID</code> — copie o id do terminal abaixo pra variável na Vercel.`
      }</p>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Terminal</th><th>Modo</th><th></th></tr></thead>
        <tbody>${r.terminais
          .map((t) => `<tr>
            <td><code>${escapeHtml(t.id)}</code>${t.selecionado ? ` <span class="tag ativo">em uso</span>` : ""}${t.caixa_externo ? `<div class="muted">caixa ${escapeHtml(String(t.caixa_externo))}</div>` : ""}</td>
            <td>${t.modo === "PDV" ? `<span class="tag ativo">PDV</span>` : `<span class="tag sem_estoque">${escapeHtml(t.modo || "?")}</span>`}</td>
            <td class="right">${
              t.modo === "PDV"
                ? `<button class="btn ghost pt-modo" data-id="${escapeHtml(t.id)}" data-modo="STANDALONE">Voltar ao modo autônomo</button>`
                : `<button class="btn ghost pt-modo" data-id="${escapeHtml(t.id)}" data-modo="PDV">Colocar em modo PDV</button>`
            }</td>
          </tr>`)
          .join("")}</tbody>
      </table></div>
      <p class="muted" style="margin-top:8px">Modo PDV: a maquininha espera as cobranças do sistema. Modo autônomo: funciona sozinha, como uma maquininha comum (use se o sistema ou a internet cair).</p>`;
    box.querySelectorAll(".pt-modo").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await clientePointDaTela().definirModo(b.dataset.id, b.dataset.modo);
          toast(b.dataset.modo === "PDV" ? "Maquininha em modo PDV." : "Maquininha em modo autônomo.", "ok");
          listarTerminais();
        } catch (e) {
          b.disabled = false;
          toast(e?.message || "Não foi possível trocar o modo.", "err");
        }
      };
    });
  } catch (e) {
    box.innerHTML = `<p style="color:var(--err)">${escapeHtml(e?.message || "Falha ao consultar.")}</p>
      <p class="muted">Confira a URL da API, se ela está no ar e se as variáveis (<code>MP_ACCESS_TOKEN</code>, <code>FIREBASE_SERVICE_ACCOUNT</code>) estão na Vercel.</p>`;
  }
}
document.getElementById("testar-point").onclick = listarTerminais;

document.getElementById("salvar-ind").onclick = async () => {
  await setDoc(
    doc(db, "configuracoes", "indicadores"),
    {
      site_url: document.getElementById("ind-site").value.trim().replace(/\/+$/, ""),
      percentual: parseNum(document.getElementById("ind-pct").value),
      categorias_excluidas: document
        .getElementById("ind-cat")
        .value.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
  toast("Configuracoes de indicadores salvas.", "ok");
};
