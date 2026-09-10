import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, getDoc, query, orderBy, limit,
  doc, updateDoc, runTransaction, serverTimestamp,
} from "../db.js";
import { brl } from "../money.js";
import { derivarItensPedido } from "../produtos-schema.js";

// ── Pedidos do SITE (colecao `pedidos`, compartilhada com flora-5754a) ──────
// O pedido do site NAO guarda valor: itens = {produtoId, quantidade, modo}.
// O total e derivado do catalogo atual (mesma ideia da apuracao de indicadores).
// Baixa de estoque = opcao B: ao entrar num status que "consome" (pago em
// diante), uma transacao decrementa estoqueVarejo/estoqueAtacado e marca
// `estoqueBaixado: true` no pedido (evita baixa dupla). Cancelar um pedido que
// ja baixou devolve o estoque. As rules ja permitem `update` de `pedidos` e de
// `produtos` para admin — nada muda no site.

const STATUS = ["aguardando_pagamento", "pago", "preparando", "enviado", "entregue", "cancelado"];
const STATUS_LABEL = {
  aguardando_pagamento: "Aguardando pagamento",
  pago: "Pago",
  preparando: "Preparando",
  enviado: "Enviado",
  entregue: "Entregue",
  cancelado: "Cancelado",
};
const STATUS_TAG = {
  aguardando_pagamento: "sem_estoque",
  pago: "ativo",
  preparando: "ativo",
  enviado: "ativo",
  entregue: "concluida",
  cancelado: "cancelada",
};
// Status em que o estoque ja deve estar baixado.
const CONSOME_ESTOQUE = new Set(["pago", "preparando", "enviado", "entregue"]);

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "pedidos" });
root.innerHTML = `<div class="card">Carregando...</div>`;

let produtosMap = new Map();
let compradores = {};
let pedidos = [];
let filtroStatus = "";

root.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:end">
      <div>
        <label>Status</label>
        <select id="fstatus">
          <option value="">Todos</option>
          ${STATUS.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}
        </select>
      </div>
      <div style="flex:0 0 auto"><button class="btn" id="atualizar">Atualizar</button></div>
    </div>
    <p class="muted" style="margin:8px 0 0">Ultimos 300 pedidos do site. Total derivado dos precos atuais do catalogo (o pedido do site nao guarda valor) e sem frete.</p>
  </div>
  <div class="card"><div id="lista">Carregando...</div></div>`;

document.getElementById("fstatus").onchange = () => {
  filtroStatus = document.getElementById("fstatus").value;
  renderLista();
};
document.getElementById("atualizar").onclick = carregar;

await carregar();

async function carregar() {
  const lista = document.getElementById("lista");
  lista.innerHTML = `<div class="card">Carregando...</div>`;
  try {
    const [prodSnap, pedSnap] = await Promise.all([
      getDocs(collection(db, "produtos")),
      getDocs(query(collection(db, "pedidos"), orderBy("criadoEm", "desc"), limit(300))),
    ]);
    produtosMap = new Map(prodSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    pedidos = pedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // nomes dos compradores (uids unicos; clientes repetidos contam uma vez)
    const uids = [...new Set(pedidos.map((p) => p.uidComprador).filter(Boolean))];
    compradores = {};
    await Promise.all(
      uids.map(async (uid) => {
        try {
          const s = await getDoc(doc(db, "usuarios", uid));
          if (s.exists()) compradores[uid] = s.data();
        } catch (_) {}
      })
    );
    renderLista();
  } catch (e) {
    erroCard(lista, e, carregar);
  }
}

function nomeComprador(uid) {
  const u = compradores[uid];
  return u ? (u.nome || u.email || uid) : (uid ? uid.slice(0, 8) + "…" : "-");
}

function renderLista() {
  const arr = filtroStatus ? pedidos.filter((p) => (p.status || "") === filtroStatus) : pedidos;

  document.getElementById("lista").innerHTML = `
    <table>
      <thead><tr>
        <th>Data</th><th>Comprador</th><th>Entrega</th><th class="right">Itens</th>
        <th class="right">Total (itens)</th><th>Ref</th><th>Estoque</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${
          arr
            .map((p) => {
              const { subtotal, itensCount } = derivarItensPedido(p, produtosMap);
              return `<tr>
                <td>${fmtData(p.criadoEm)}</td>
                <td>${escapeHtml(nomeComprador(p.uidComprador))}</td>
                <td>${p.modoEntrega === "entrega" ? "Entrega" : "Retirada"}</td>
                <td class="right">${itensCount}</td>
                <td class="right">${brl(subtotal)}</td>
                <td>${p.ref ? `<code>${escapeHtml(String(p.ref))}</code>` : "-"}</td>
                <td>${p.estoqueBaixado ? `<span class="tag ativo">baixado</span>` : `<span class="muted">-</span>`}</td>
                <td><span class="tag ${STATUS_TAG[p.status] || ""}">${STATUS_LABEL[p.status] || p.status || "-"}</span></td>
                <td class="right"><button class="btn ghost ver" data-id="${p.id}">Ver</button></td>
              </tr>`;
            })
            .join("") || `<tr><td colspan="9" class="muted">Nenhum pedido.</td></tr>`
        }
      </tbody>
    </table>`;

  document.querySelectorAll(".ver").forEach(
    (b) => (b.onclick = () => detalhe(pedidos.find((p) => p.id === b.dataset.id)))
  );
}

function detalhe(p) {
  const { linhas, subtotal, temItemSemCatalogo } = derivarItensPedido(p, produtosMap);
  const u = compradores[p.uidComprador];
  const end = p.endereco;

  const c = document.createElement("div");
  c.innerHTML = `
    <p class="muted">${fmtData(p.criadoEm)} &middot; ${p.modoEntrega === "entrega" ? "Entrega" : "Retirada"} &middot;
      pagamento ${escapeHtml(p.pagamento?.metodo || "-")} (${escapeHtml(p.pagamento?.status || "-")})
      ${p.ref ? `&middot; indicador <code>${escapeHtml(String(p.ref))}</code>` : ""}</p>

    <strong>Comprador</strong>
    <p>${escapeHtml(u?.nome || "-")}${u?.email ? ` &middot; ${escapeHtml(u.email)}` : ""}${u?.telefone ? ` &middot; ${escapeHtml(u.telefone)}` : ""}</p>
    ${
      p.modoEntrega === "entrega" && end
        ? `<p class="muted">${escapeHtml(end.endereco || "")}${end.bairro ? " &middot; " + escapeHtml(end.bairro) : ""}${end.cep ? " &middot; CEP " + escapeHtml(end.cep) : ""}</p>`
        : ""
    }

    <strong style="display:block;margin-top:12px">Itens</strong>
    <table><tbody>
      ${linhas
        .map(
          (l) => `<tr>
            <td>${l.qtd}x ${escapeHtml(l.nome)}${l.modo === "atacado" ? ' <span class="tag">atacado</span>' : ""}${l.semCatalogo ? ' <span class="tag cancelada">sem catalogo</span>' : ""}</td>
            <td class="right">${brl(l.subtotal)}</td>
          </tr>`
        )
        .join("")}
    </tbody></table>
    <div class="totais big"><span>Total (itens, sem frete)</span><span>${brl(subtotal)}</span></div>
    ${temItemSemCatalogo ? `<p style="color:var(--warn)">Algum item nao existe mais no catalogo — o total ignora esses itens.</p>` : ""}

    <strong style="display:block;margin-top:14px">Status</strong>
    <p class="muted">Atual: <strong>${STATUS_LABEL[p.status] || p.status || "-"}</strong>${p.estoqueBaixado ? " &middot; estoque ja baixado" : ""}</p>
    <div class="row" style="align-items:end">
      <div>
        <label>Mudar para</label>
        <select id="novo-status">
          ${STATUS.filter((s) => s !== p.status).map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}
        </select>
      </div>
      <div style="flex:0 0 auto"><button class="btn" id="aplicar-status">Aplicar</button></div>
    </div>
    <p class="muted" id="status-msg"></p>`;

  const bg = modal({ titulo: `Pedido ${p.id.slice(0, 8)}…`, corpo: c, textoCancelar: "Fechar" });

  const sel = c.querySelector("#novo-status");
  const msg = c.querySelector("#status-msg");
  const pintarMsg = () => {
    const novo = sel.value;
    if (CONSOME_ESTOQUE.has(novo) && !p.estoqueBaixado)
      msg.textContent = "Ao aplicar, o estoque dos itens sera baixado do catalogo.";
    else if (novo === "cancelado" && p.estoqueBaixado)
      msg.textContent = "Ao cancelar, o estoque dos itens sera devolvido ao catalogo.";
    else msg.textContent = "Só muda o status (estoque nao muda).";
  };
  sel.onchange = pintarMsg;
  pintarMsg();

  c.querySelector("#aplicar-status").onclick = async () => {
    const novo = sel.value;
    const consumir = CONSOME_ESTOQUE.has(novo) && !p.estoqueBaixado;
    const devolver = novo === "cancelado" && p.estoqueBaixado === true;
    const aviso = consumir
      ? " O estoque dos itens sera baixado."
      : devolver
      ? " O estoque dos itens sera devolvido."
      : "";
    if (!(await confirmar(`Mudar o pedido para "${STATUS_LABEL[novo]}"?${aviso}`))) return;
    try {
      await mudarStatus(p, novo);
      toast("Pedido atualizado.", "ok");
      bg.remove();
      carregar();
    } catch (e) {
      toast(e?.message || "Falha ao atualizar o pedido.", "err");
    }
  };
}

async function mudarStatus(pedido, novoStatus) {
  const ref = doc(db, "pedidos", pedido.id);
  const vaiConsumir = CONSOME_ESTOQUE.has(novoStatus) && !pedido.estoqueBaixado;
  const vaiDevolver = novoStatus === "cancelado" && pedido.estoqueBaixado === true;

  if (!vaiConsumir && !vaiDevolver) {
    await updateDoc(ref, { status: novoStatus, atualizadoEm: serverTimestamp() });
    return;
  }

  await runTransaction(db, async (t) => {
    const pSnap = await t.get(ref);
    if (!pSnap.exists()) throw new Error("Pedido nao encontrado.");
    const ped = pSnap.data();

    // Reconfirma o estado do estoque no momento da transacao (evita corrida).
    const jaBaixado = ped.estoqueBaixado === true;
    if (vaiConsumir && jaBaixado) {
      t.update(ref, { status: novoStatus, atualizadoEm: serverTimestamp() });
      return;
    }
    if (vaiDevolver && !jaBaixado) {
      t.update(ref, { status: novoStatus, atualizadoEm: serverTimestamp() });
      return;
    }

    // Agrupa itens por produto + campo de estoque (varejo/atacado).
    const grupos = new Map();
    for (const it of ped.itens || []) {
      const modo = it.modo === "atacado" ? "atacado" : "varejo";
      const campo = modo === "atacado" ? "estoqueAtacado" : "estoqueVarejo";
      const qtd = Math.max(0, Math.trunc(Number(it.quantidade ?? it.qtd) || 0));
      if (!qtd || !it.produtoId) continue;
      const key = it.produtoId + "|" + campo;
      const g = grupos.get(key) || { produtoId: it.produtoId, campo, qtd: 0 };
      g.qtd += qtd;
      grupos.set(key, g);
    }
    const entradas = [...grupos.values()];
    const lidos = [];
    for (const g of entradas) {
      const pr = doc(db, "produtos", g.produtoId);
      lidos.push({ g, pr, snap: await t.get(pr) });
    }

    if (vaiConsumir) {
      for (const { g, snap } of lidos) {
        if (!snap.exists()) throw new Error(`Um item aponta para um produto que nao existe mais (${g.produtoId}).`);
        const atual = Number(snap.data()[g.campo] ?? snap.data().estoque ?? 0);
        if (atual < g.qtd)
          throw new Error(`Estoque insuficiente de "${snap.data().nome || g.produtoId}": tem ${atual}, precisa ${g.qtd}.`);
      }
      for (const { g, pr, snap } of lidos) {
        const atual = Number(snap.data()[g.campo] ?? snap.data().estoque ?? 0);
        t.update(pr, { [g.campo]: atual - g.qtd, atualizadoEm: serverTimestamp() });
      }
      t.update(ref, {
        status: novoStatus,
        estoqueBaixado: true,
        estoqueBaixadoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp(),
      });
    } else {
      for (const { g, pr, snap } of lidos) {
        if (!snap.exists()) continue;
        const atual = Number(snap.data()[g.campo] ?? snap.data().estoque ?? 0);
        t.update(pr, { [g.campo]: atual + g.qtd, atualizadoEm: serverTimestamp() });
      }
      t.update(ref, {
        status: novoStatus,
        estoqueBaixado: false,
        estoqueDevolvidoEm: serverTimestamp(),
        atualizadoEm: serverTimestamp(),
      });
    }
  });
}
