import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml } from "../ui.js";
import {
  db, collection, getDocs, query, orderBy, where, Timestamp,
  doc, addDoc, updateDoc, deleteDoc, serverTimestamp,
  getConfigIndicadores, periodoParaIntervalo,
} from "../db.js";
import { brl, round2 } from "../money.js";
import { baseElegivelIndicador } from "../produtos-schema.js";

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "indicadores" });

const cfg = await getConfigIndicadores();
const siteUrl = (cfg.site_url || "").replace(/\/+$/, "");
const pct = Number(cfg.percentual ?? 5);
const janela = Number(cfg.janela_dias ?? 7);
const excluirSlugs = cfg.categorias_excluidas || [];
const excluidasTxt = excluirSlugs.join(", ") || "(so iPhone, por prefixo)";

const agora = new Date();
let periodo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
let indicadores = [];

root.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:center">
      <button class="btn" id="novo">+ Indicador</button>
      <span class="muted">Comissao: <strong>${pct}%</strong> &middot; link vale <strong>${janela} dias</strong> &middot; sem comissao: iPhone${excluirSlugs.length ? " + " + escapeHtml(excluidasTxt) : ""} &middot; <a href="/config">alterar</a></span>
    </div>
  </div>
  <div class="card"><div id="tabela">Carregando...</div></div>

  <div class="card">
    <strong>Apuracao de comissoes &mdash; pedidos do site</strong>
    <p class="muted">Considera <code>pedidos</code> com um <code>ref</code> de indicador (link <code>?ref=</code>), status diferente de cancelado. O total e derivado do catalogo atual; iPhone nao entra na base. Pagamento e manual.</p>
    <div class="row">
      <div><label>Periodo</label><input type="month" id="periodo" value="${periodo}"></div>
      <div style="align-self:end"><button class="btn" id="apurar">Apurar</button></div>
    </div>
    <div id="apuracao" style="margin-top:10px"></div>
  </div>`;

document.getElementById("novo").onclick = () => editar(null);
document.getElementById("apurar").onclick = () => {
  periodo = document.getElementById("periodo").value || periodo;
  apurar();
};

await carregar();
await apurar();

function normalizaCodigo(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "")
    .slice(0, 24);
}

function linkDe(codigo) {
  const base = siteUrl || "https://SEU-SITE";
  return `${base}/?ref=${encodeURIComponent(codigo)}`;
}

async function carregar() {
  const snap = await getDocs(query(collection(db, "indicadores"), orderBy("nome")));
  indicadores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderTabela();
}

function renderTabela() {
  document.getElementById("tabela").innerHTML = `
    <table>
      <thead><tr>
        <th>Nome</th><th>Codigo</th><th>Link</th><th>Contato</th><th>Ativo</th><th></th>
      </tr></thead>
      <tbody>
        ${
          indicadores
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.nome || "-")}</td>
                <td><code>${escapeHtml(r.codigo || "")}</code></td>
                <td><button class="btn ghost copiar" data-cod="${escapeHtml(r.codigo || "")}">Copiar link</button></td>
                <td>${escapeHtml(r.contato || "")}</td>
                <td><span class="tag ${r.ativo === false ? "inativo" : "ativo"}">${r.ativo === false ? "inativo" : "ativo"}</span></td>
                <td class="right"><button class="btn ghost editar" data-id="${r.id}">Editar</button></td>
              </tr>`
            )
            .join("") || `<tr><td colspan="6" class="muted">Nenhum indicador cadastrado.</td></tr>`
        }
      </tbody>
    </table>`;

  document.querySelectorAll(".editar").forEach(
    (b) => (b.onclick = () => editar(indicadores.find((r) => r.id === b.dataset.id)))
  );
  document.querySelectorAll(".copiar").forEach(
    (b) => (b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(linkDe(b.dataset.cod));
        toast("Link copiado.", "ok");
      } catch (_) {
        toast(linkDe(b.dataset.cod), "");
      }
    })
  );
}

function editar(r) {
  const c = document.createElement("div");
  c.innerHTML = `
    <label>Nome</label><input id="r-nome" value="${escapeHtml(r?.nome || "")}">
    <label>Codigo do link (usado em ?ref=)</label>
    <input id="r-cod" value="${escapeHtml(r?.codigo || "")}" placeholder="ex.: JOAO ou MARIA02">
    <label>Contato (telefone / e-mail)</label><input id="r-contato" value="${escapeHtml(r?.contato || "")}">
    <label style="text-transform:none"><input type="checkbox" id="r-ativo" ${r?.ativo === false ? "" : "checked"} style="width:auto"> Indicador ativo</label>
    <p class="muted" id="r-preview">${r ? "Link: " + escapeHtml(linkDe(r.codigo || "")) : ""}</p>
    ${r ? `<button class="btn danger" id="r-del" style="margin-top:12px">Excluir indicador</button>` : ""}`;

  const codInput = c.querySelector("#r-cod");
  const preview = c.querySelector("#r-preview");
  codInput.oninput = () => {
    codInput.value = normalizaCodigo(codInput.value);
    preview.textContent = codInput.value ? "Link: " + linkDe(codInput.value) : "";
  };

  const bg = modal({
    titulo: r ? "Editar indicador" : "Novo indicador",
    corpo: c,
    onConfirmar: async () => {
      const nome = c.querySelector("#r-nome").value.trim();
      const codigo = normalizaCodigo(c.querySelector("#r-cod").value);
      const contato = c.querySelector("#r-contato").value.trim();
      const ativo = c.querySelector("#r-ativo").checked;

      if (!nome || !codigo) {
        toast("Nome e codigo sao obrigatorios.", "err");
        return false;
      }
      const dup = indicadores.find((x) => x.codigo === codigo && x.id !== r?.id);
      if (dup) {
        toast(`Codigo "${codigo}" ja e do indicador ${dup.nome}.`, "err");
        return false;
      }

      const dados = { nome, codigo, contato, ativo, atualizadoEm: serverTimestamp(), atualizadoPor: perfil.id };
      if (r) await updateDoc(doc(db, "indicadores", r.id), dados);
      else await addDoc(collection(db, "indicadores"), { ...dados, criadoEm: serverTimestamp() });
      toast("Indicador salvo.", "ok");
      carregar();
    },
  });

  if (r)
    c.querySelector("#r-del").onclick = async () => {
      if (!(await confirmar(`Excluir "${r.nome}"? Os pedidos ja atribuidos continuam no historico.`))) return;
      await deleteDoc(doc(db, "indicadores", r.id));
      bg.remove();
      toast("Indicador excluido.", "ok");
      carregar();
    };
}

async function apurar() {
  const box = document.getElementById("apuracao");
  box.innerHTML = `<p class="muted">Apurando...</p>`;

  const { inicio, fim } = periodoParaIntervalo(periodo);

  let pedidos, produtosSnap, camadasSnap;
  try {
    [pedidos, produtosSnap, camadasSnap] = await Promise.all([
      getDocs(query(
        collection(db, "pedidos"),
        where("criadoEm", ">=", Timestamp.fromDate(inicio)),
        where("criadoEm", "<", Timestamp.fromDate(fim)),
        orderBy("criadoEm", "desc")
      )).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      getDocs(collection(db, "produtos")),
      getDocs(query(collection(db, "camadas"), orderBy("ordem", "asc"))),
    ]);
  } catch (e) {
    box.innerHTML = `<p style="color:var(--warn)">Nao foi possivel apurar (${escapeHtml(e?.message || "")}).</p>`;
    return;
  }

  const produtosMap = new Map(produtosSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const camadaPrincipalSlug = camadasSnap.docs.length ? (camadasSnap.docs[0].data().slug || null) : null;
  const nomePorCodigo = Object.fromEntries(indicadores.map((r) => [r.codigo, r]));

  const comRef = pedidos.filter((p) => p.ref && p.status !== "cancelado");

  const agg = {};
  for (const p of comRef) {
    const cod = String(p.ref);
    const a = agg[cod] || (agg[cod] = { qtd: 0, base: 0, comissao: 0 });
    const { base } = baseElegivelIndicador(p, produtosMap, { camadaPrincipalSlug, excluirSlugs });
    a.qtd++;
    a.base = round2(a.base + base);
    a.comissao = round2(a.base * pct / 100);
  }

  const linhas = Object.entries(agg)
    .sort((x, y) => (nomePorCodigo[x[0]]?.nome || x[0]).localeCompare(nomePorCodigo[y[0]]?.nome || y[0]))
    .map(([cod, a]) => {
      const rev = nomePorCodigo[cod];
      return `<tr>
        <td>${escapeHtml(rev?.nome || `(codigo ${cod} sem cadastro)`)}</td>
        <td><code>${escapeHtml(cod)}</code></td>
        <td class="right">${a.qtd}</td>
        <td class="right">${brl(a.base)}</td>
        <td class="right">${brl(a.comissao)}</td>
      </tr>`;
    })
    .join("");

  const totBase = round2(Object.values(agg).reduce((s, a) => s + a.base, 0));
  const totCom = round2(totBase * pct / 100);

  box.innerHTML = `
    <table>
      <thead><tr>
        <th>Indicador</th><th>Codigo</th><th class="right">Pedidos</th>
        <th class="right">Base elegivel</th><th class="right">Comissao (${pct}%)</th>
      </tr></thead>
      <tbody>
        ${linhas || `<tr><td colspan="5" class="muted">Sem pedidos com indicador no periodo.</td></tr>`}
        ${linhas ? `<tr><td colspan="3"><strong>TOTAL</strong></td><td class="right"><strong>${brl(totBase)}</strong></td><td class="right"><strong>${brl(totCom)}</strong></td></tr>` : ""}
      </tbody>
    </table>
    <p class="muted">Total derivado dos precos atuais do catalogo (pedido do site nao guarda valor). Pagamento manual.</p>`;
}
