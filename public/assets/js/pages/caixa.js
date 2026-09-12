import { requireAuth } from "../auth.js";
import { initShell, toast, modal, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where, orderBy, limit,
  doc, addDoc, updateDoc, serverTimestamp, arrayUnion, Timestamp,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "caixa" });

render();

// Caixa e UNICO pra loja toda, nao "do usuario logado" — antes cada conta
// (admin/vendedor) enxergava so o proprio caixa, entao dava pra duas pessoas
// abrirem caixas "paralelos" ao mesmo tempo sem perceber (dinheiro vendido
// por uma ficava fora do caixa que a outra estava fechando). Agora so pode
// haver um caixa "aberto" no sistema inteiro, e qualquer staff opera nele.
async function caixaAberto() {
  const s = (await getDocs(query(
    collection(db, "caixa"),
    where("status", "==", "aberto")
  ))).docs[0];
  return s ? { id: s.id, ...s.data() } : null;
}

async function render() {
  root.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    await renderBody();
  } catch (e) {
    erroCard(root, e, render);
  }
}

async function renderBody() {
  const caixa = await caixaAberto();
  const hist = (await getDocs(query(
    collection(db, "caixa"),
    orderBy("aberto_em", "desc"),
    limit(10)
  ))).docs.map((d) => ({ id: d.id, ...d.data() }));

  if (!caixa) {
    root.innerHTML = `
      <div class="card">
        <strong>Abrir caixa</strong>
        <p class="muted">Nao ha caixa aberto no momento.</p>
        <label>Valor de abertura (fundo de troco)</label>
        <input id="abertura" value="0" inputmode="decimal">
        <button class="btn" id="btn-abrir" style="margin-top:12px">Abrir caixa</button>
      </div>
      ${histHtml(hist)}`;
    document.getElementById("btn-abrir").onclick = async () => {
      if (await caixaAberto()) return toast("Ja existe um caixa aberto.", "warn");
      await addDoc(collection(db, "caixa"), {
        data: new Date().toISOString().slice(0, 10),
        aberto_por_uid: perfil.id,
        aberto_por_nome: perfil.nome || "",
        aberto_em: serverTimestamp(),
        valor_abertura: round2(parseNum(document.getElementById("abertura").value)),
        movimentos: [],
        status: "aberto",
      });
      toast("Caixa aberto.", "ok");
      render();
    };
    return;
  }

  // Sem filtro por vendedor_uid: o caixa e compartilhado, entao a
  // conferencia precisa somar as vendas de TODA a equipe que vendeu
  // enquanto esse caixa esteve aberto, nao so as do usuario logado agora.
  const vendas = (await getDocs(query(
    collection(db, "vendas"),
    where("caixa_id", "==", caixa.id)
  ))).docs
    .map((d) => d.data())
    .filter((v) => v.status === "concluida");

  const porForma = {};
  vendas.forEach((v) =>
    (v.pagamentos || []).forEach((p) => (porForma[p.forma] = round2((porForma[p.forma] || 0) + p.valor)))
  );
  const movs = caixa.movimentos || [];
  const sangrias = round2(movs.filter((m) => m.tipo === "sangria").reduce((s, m) => s + m.valor, 0));
  const suprimentos = round2(movs.filter((m) => m.tipo === "suprimento").reduce((s, m) => s + m.valor, 0));
  const totalVendas = round2(Object.values(porForma).reduce((s, v) => s + v, 0));
  const esperadoDinheiro = round2(
    caixa.valor_abertura + (porForma.dinheiro || 0) + suprimentos - sangrias
  );

  root.innerHTML = `
    <div class="card">
      <strong>Caixa aberto</strong>
      <p class="muted">Aberto em ${fmtData(caixa.aberto_em)} por ${escapeHtml(caixa.aberto_por_nome || "-")} &middot; abertura ${brl(caixa.valor_abertura)}</p>
      <div class="grid cols-3">
        <div class="kpi"><div class="l">Vendas no caixa</div><div class="n">${vendas.length}</div></div>
        <div class="kpi"><div class="l">Total vendido</div><div class="n">${brl(totalVendas)}</div></div>
        <div class="kpi"><div class="l">Dinheiro esperado</div><div class="n">${brl(esperadoDinheiro)}</div></div>
      </div>
      <table style="margin-top:12px"><tbody>
        ${
          Object.entries(porForma)
            .map(([f, v]) => `<tr><td>${f}</td><td class="right">${brl(v)}</td></tr>`)
            .join("") || `<tr><td class="muted">Sem vendas ainda.</td></tr>`
        }
        <tr><td>Suprimentos</td><td class="right">${brl(suprimentos)}</td></tr>
        <tr><td>Sangrias</td><td class="right">- ${brl(sangrias)}</td></tr>
      </tbody></table>
      <div class="row" style="margin-top:12px">
        <button class="btn ghost" id="btn-sup">Suprimento</button>
        <button class="btn ghost" id="btn-san">Sangria</button>
        <button class="btn" id="btn-fechar">Fechar caixa</button>
      </div>
    </div>

    <div class="card">
      <strong>Movimentos</strong>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Quando</th><th>Quem</th><th>Tipo</th><th>Motivo</th><th class="right">Valor</th></tr></thead>
        <tbody>
          ${
            movs
              .slice()
              .reverse()
              .map(
                (m) => `<tr><td>${fmtData(m.em)}</td><td>${escapeHtml(m.nome || "-")}</td><td>${m.tipo}</td><td>${escapeHtml(m.motivo || "")}</td><td class="right">${brl(m.valor)}</td></tr>`
              )
              .join("") || `<tr><td class="muted">-</td></tr>`
          }
        </tbody>
      </table></div>
    </div>

    ${histHtml(hist)}`;

  document.getElementById("btn-sup").onclick = () => movimento("suprimento", caixa.id);
  document.getElementById("btn-san").onclick = () => movimento("sangria", caixa.id);
  document.getElementById("btn-fechar").onclick = () =>
    fechar(caixa, esperadoDinheiro, { porForma, totalVendas, sangrias, suprimentos });
}

function histHtml(hist) {
  return `
    <div class="card">
      <strong>Historico (ultimos caixas)</strong>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Data</th><th>Aberto por</th><th>Abertura</th><th>Fechamento</th><th>Diferenca</th><th>Status</th></tr></thead>
        <tbody>
          ${
            hist
              .map(
                (c) => `<tr>
                  <td>${c.data || fmtData(c.aberto_em)}</td>
                  <td>${escapeHtml(c.aberto_por_nome || "-")}</td>
                  <td>${brl(c.valor_abertura)}</td>
                  <td>${c.status === "fechado" ? brl(c.valor_fechamento_informado) : "-"}</td>
                  <td>${c.status === "fechado" ? brl(c.resumo?.diferenca || 0) : "-"}</td>
                  <td><span class="tag ${c.status === "aberto" ? "ativo" : "descontinuado"}">${c.status}</span></td>
                </tr>`
              )
              .join("") || `<tr><td class="muted">-</td></tr>`
          }
        </tbody>
      </table></div>
    </div>`;
}

function movimento(tipo, caixaId) {
  const c = document.createElement("div");
  c.innerHTML = `
    <label>Valor</label><input id="mv" inputmode="decimal" value="0">
    <label>Motivo</label><input id="mm" placeholder="Ex.: troco, pagamento fornecedor">`;
  modal({
    titulo: tipo === "sangria" ? "Registrar sangria" : "Registrar suprimento",
    corpo: c,
    onConfirmar: async () => {
      const valor = round2(parseNum(c.querySelector("#mv").value));
      if (valor <= 0) {
        toast("Valor invalido.", "err");
        return false;
      }
      await updateDoc(doc(db, "caixa", caixaId), {
        movimentos: arrayUnion({
          tipo,
          valor,
          motivo: c.querySelector("#mm").value.trim(),
          uid: perfil.id,
          nome: perfil.nome || "",
          em: Timestamp.now(),
        }),
      });
      toast("Movimento registrado.", "ok");
      render();
    },
  });
}

function fechar(caixa, esperadoDinheiro, parcial) {
  const c = document.createElement("div");
  c.innerHTML = `
    <p>Dinheiro esperado na gaveta: <strong>${brl(esperadoDinheiro)}</strong></p>
    <label>Valor contado em dinheiro</label>
    <input id="contado" inputmode="decimal" value="0">`;
  modal({
    titulo: "Fechar caixa",
    corpo: c,
    textoConfirmar: "Fechar",
    onConfirmar: async () => {
      const informado = round2(parseNum(c.querySelector("#contado").value));
      const diferenca = round2(informado - esperadoDinheiro);
      await updateDoc(doc(db, "caixa", caixa.id), {
        status: "fechado",
        fechado_por_uid: perfil.id,
        fechado_por_nome: perfil.nome || "",
        fechado_em: serverTimestamp(),
        valor_fechamento_informado: informado,
        resumo: {
          por_forma: parcial.porForma,
          total_vendas: parcial.totalVendas,
          sangrias: parcial.sangrias,
          suprimentos: parcial.suprimentos,
          saldo_esperado_dinheiro: esperadoDinheiro,
          diferenca,
        },
      });
      toast(`Caixa fechado. Diferenca: ${brl(diferenca)}`, diferenca === 0 ? "ok" : "warn");
      render();
    },
  });
}
