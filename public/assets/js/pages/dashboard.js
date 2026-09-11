import { requireAuth } from "../auth.js";
import { initShell, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, query, where, orderBy, getDocs, Timestamp,
  inicioDoDia, inicioDoMes,
} from "../db.js";
import { brl } from "../money.js";

const CANAIS = { loja: "Loja fisica", site: "Site proprio", mercado_livre: "Mercado Livre", shopee: "Shopee" };

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "dashboard" });
root.innerHTML = `<div class="card">Carregando...</div>`;

const ehAdm = perfil.role === "admin";

try {
const t0 = Timestamp.fromDate(inicioDoDia());
const m0 = Timestamp.fromDate(inicioDoMes());

// ---- vendas de hoje ----
const qHoje = ehAdm
  ? query(collection(db, "vendas"), where("data", ">=", t0), orderBy("data", "desc"))
  : query(collection(db, "vendas"), where("vendedor_uid", "==", perfil.id), where("data", ">=", t0), orderBy("data", "desc"));
const vendasHoje = (await getDocs(qHoje)).docs
  .map((d) => d.data())
  .filter((v) => v.status === "concluida");

const totalHoje = vendasHoje.reduce((s, v) => s + (v.total || 0), 0);
const qtdHoje = vendasHoje.length;
const ticket = qtdHoje ? totalHoje / qtdHoje : 0;

const porCanal = {};
vendasHoje.forEach((v) => (porCanal[v.canal] = (porCanal[v.canal] || 0) + (v.total || 0)));

// ---- caixa aberto do usuario ----
const caixaDoc = (await getDocs(query(
  collection(db, "caixa"),
  where("aberto_por_uid", "==", perfil.id),
  where("status", "==", "aberto")
))).docs[0];
const caixa = caixaDoc ? caixaDoc.data() : null;

// ---- comissao do mes (loja) ----
const qCom = ehAdm
  ? query(collection(db, "vendas"), where("canal", "==", "loja"), where("status", "==", "concluida"), where("data", ">=", m0))
  : query(collection(db, "vendas"), where("vendedor_uid", "==", perfil.id), where("data", ">=", m0));
const vendasMes = (await getDocs(qCom)).docs
  .map((d) => d.data())
  .filter((v) => v.canal === "loja" && v.status === "concluida");
const comissaoMes = vendasMes.reduce((s, v) => s + (v.comissao?.valor || 0), 0);

// ---- top produtos hoje ----
const prod = {};
vendasHoje.forEach((v) =>
  (v.itens || []).forEach((it) => {
    // Catalogo do site nao tem `sku`; agrupa pelo produtoId (fallbacks p/ legado).
    const chave = it.produtoId || it.codigoBarras || it.sku || it.nome || "?";
    const p = prod[chave] || (prod[chave] = { nome: it.nome, qtd: 0, total: 0 });
    p.qtd += it.qtd || 0;
    p.total += it.subtotal || 0;
  })
);
const top = Object.values(prod).sort((a, b) => b.qtd - a.qtd).slice(0, 5);

root.innerHTML = `
  <div class="grid cols-4">
    <div class="card kpi"><div class="l">Vendas hoje</div><div class="n">${qtdHoje}</div></div>
    <div class="card kpi"><div class="l">Faturamento hoje</div><div class="n">${brl(totalHoje)}</div></div>
    <div class="card kpi"><div class="l">Ticket medio</div><div class="n">${brl(ticket)}</div></div>
    <div class="card kpi"><div class="l">${ehAdm ? "Comissoes no mes" : "Minha comissao no mes"}</div><div class="n">${brl(comissaoMes)}</div></div>
  </div>

  <div class="card">
    <strong>Caixa</strong>
    <p class="${caixa ? "" : "muted"}">${
      caixa
        ? `Aberto em ${fmtData(caixa.aberto_em)} &middot; abertura ${brl(caixa.valor_abertura)}`
        : "Nenhum caixa aberto por voce. Abra o caixa antes de vender em dinheiro."
    }</p>
    <a class="btn sec" href="/caixa">Ir para o caixa</a>
  </div>

  <div class="card">
    <strong>Vendas de hoje por canal</strong>
    <table><tbody>
      ${
        Object.entries(porCanal)
          .map(([c, v]) => `<tr><td>${CANAIS[c] || c}</td><td class="right">${brl(v)}</td></tr>`)
          .join("") || `<tr><td class="muted">Sem vendas hoje.</td></tr>`
      }
    </tbody></table>
  </div>

  <div class="card">
    <strong>Top produtos hoje</strong>
    <div class="tabela-wrap"><table>
      <thead><tr><th>Produto</th><th class="right">Qtd</th><th class="right">Total</th></tr></thead>
      <tbody>
        ${
          top
            .map((p) => `<tr><td>${escapeHtml(p.nome)}</td><td class="right">${p.qtd}</td><td class="right">${brl(p.total)}</td></tr>`)
            .join("") || `<tr><td class="muted">-</td></tr>`
        }
      </tbody>
    </table></div>
  </div>`;
} catch (e) {
  erroCard(root, e);
}
