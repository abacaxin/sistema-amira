import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where, orderBy,
  doc, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
  periodoParaIntervalo,
} from "../db.js";
import { brl, parseNum, round2 } from "../money.js";

// ── Gastos/despesas da loja (aluguel, fornecedor, etc.) ──────────────────
// Coleçao PROPRIA (nao reaproveita a sangria do caixa): um gasto e "solto"
// por data, nao amarrado a uma sessao de caixa especifica — da pra lancar
// mesmo sem caixa aberto (ex.: pagar um boleto depois de fechar a loja). O
// Caixa atribui gastos a uma sessao filtrando por essa data, e o Painel soma
// por mes. So admin cria/edita/exclui (protege o liquido reportado ao dono
// de lancamentos forjados); qualquer staff pode ler.

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "gastos" });

const agora = new Date();
let periodo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
let gastos = [];

root.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:end">
      <div><label>Periodo</label><input type="month" id="periodo" value="${periodo}"></div>
      <div style="flex:0 0 auto"><button class="btn ghost" id="buscar">Atualizar</button></div>
      <div style="flex:0 0 auto"><button class="btn" id="novo">+ Gasto</button></div>
    </div>
    <p class="muted" style="margin:8px 0 0">Gastos/despesas da loja (aluguel, fornecedor, salario, etc.) — descontados do valor liquido no Caixa (pela data, dentro do periodo de cada sessao) e na contabilidade mensal do Painel.</p>
  </div>
  <div class="card"><div id="lista">Carregando...</div></div>`;

document.getElementById("buscar").onclick = () => {
  periodo = document.getElementById("periodo").value || periodo;
  carregar();
};
document.getElementById("novo").onclick = () => editar(null);

await carregar();

async function carregar() {
  const lista = document.getElementById("lista");
  lista.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    const { inicio, fim } = periodoParaIntervalo(periodo);
    const snap = await getDocs(query(
      collection(db, "gastos"),
      where("data", ">=", Timestamp.fromDate(inicio)),
      where("data", "<", Timestamp.fromDate(fim)),
      orderBy("data", "desc")
    ));
    gastos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLista();
  } catch (e) {
    erroCard(lista, e, carregar);
  }
}

function renderLista() {
  const total = round2(gastos.reduce((s, g) => s + (Number(g.valor) || 0), 0));
  document.getElementById("lista").innerHTML = `
    <div class="tabela-wrap"><table>
      <thead><tr>
        <th>Data</th><th>Categoria</th><th>Descricao</th><th class="right">Valor</th><th></th>
      </tr></thead>
      <tbody>
        ${
          gastos
            .map(
              (g) => `<tr>
                <td>${fmtData(g.data)}</td>
                <td>${escapeHtml(g.categoria || "-")}</td>
                <td>${escapeHtml(g.descricao || "-")}</td>
                <td class="right">${brl(g.valor)}</td>
                <td class="right"><button class="btn ghost editar" data-id="${g.id}">Editar</button></td>
              </tr>`
            )
            .join("") || `<tr><td colspan="5" class="muted">Nenhum gasto no periodo.</td></tr>`
        }
        ${gastos.length ? `<tr><td colspan="3"><strong>TOTAL</strong></td><td class="right"><strong>${brl(total)}</strong></td><td></td></tr>` : ""}
      </tbody>
    </table></div>`;

  document.querySelectorAll(".editar").forEach(
    (b) => (b.onclick = () => editar(gastos.find((g) => g.id === b.dataset.id)))
  );
}

function editar(g) {
  const c = document.createElement("div");
  const dataAtual = g?.data ? (g.data.toDate ? g.data.toDate() : new Date(g.data)) : new Date();
  const dataStr = dataAtual.toISOString().slice(0, 10);
  c.innerHTML = `
    <label>Data</label><input type="date" id="g-data" value="${dataStr}">
    <label>Descricao</label><input id="g-desc" value="${escapeHtml(g?.descricao || "")}" placeholder="Ex.: aluguel de setembro">
    <label>Categoria (opcional)</label><input id="g-cat" value="${escapeHtml(g?.categoria || "")}" placeholder="Ex.: aluguel, fornecedor, salario...">
    <label>Valor (R$)</label><input id="g-valor" value="${g?.valor ?? ""}" inputmode="decimal">
    <label>Observacoes (opcional)</label><textarea id="g-obs" rows="2">${escapeHtml(g?.observacoes || "")}</textarea>
    ${g ? `<button class="btn danger" id="g-del" style="margin-top:12px">Excluir gasto</button>` : ""}`;

  const bg = modal({
    titulo: g ? "Editar gasto" : "Novo gasto",
    corpo: c,
    onConfirmar: async () => {
      const descricao = c.querySelector("#g-desc").value.trim();
      const valor = round2(parseNum(c.querySelector("#g-valor").value));
      const dataInput = c.querySelector("#g-data").value;
      if (!descricao) { toast("Descricao e obrigatoria.", "err"); return false; }
      if (!(valor > 0)) { toast("Valor deve ser maior que zero.", "err"); return false; }
      if (!dataInput) { toast("Informe a data.", "err"); return false; }

      const [ano, mes, dia] = dataInput.split("-").map(Number);
      const dados = {
        descricao,
        categoria: c.querySelector("#g-cat").value.trim(),
        valor,
        data: Timestamp.fromDate(new Date(ano, mes - 1, dia)),
        observacoes: c.querySelector("#g-obs").value.trim(),
      };

      if (g) {
        await updateDoc(doc(db, "gastos", g.id), { ...dados, atualizado_em: serverTimestamp() });
      } else {
        await addDoc(collection(db, "gastos"), {
          ...dados,
          criado_em: serverTimestamp(),
          criado_por_uid: perfil.id,
          criado_por_nome: perfil.nome || "",
        });
      }
      toast("Gasto salvo.", "ok");
      carregar();
    },
  });

  if (g)
    c.querySelector("#g-del").onclick = async () => {
      if (!(await confirmar(`Excluir o gasto "${g.descricao}"?`))) return;
      await deleteDoc(doc(db, "gastos", g.id));
      bg.remove();
      toast("Gasto excluido.", "ok");
      carregar();
    };
}
