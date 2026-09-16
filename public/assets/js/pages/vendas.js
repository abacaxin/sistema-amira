import { requireAuth } from "../auth.js";
import { initShell, toast, modal, confirmar, escapeHtml, fmtData, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where, orderBy, limit,
  doc, runTransaction, serverTimestamp, getConfigSistema,
} from "../db.js";
import { brl, round2 } from "../money.js";
import { derivarItensPedido, contaComoPago } from "../produtos-schema.js";

const CANAIS = { loja: "Loja fisica", site: "Site proprio", mercado_livre: "Mercado Livre", shopee: "Shopee" };
const FORMAS_LABEL = { dinheiro: "Dinheiro", pix: "Pix", debito: "Debito", credito: "Credito", crediario: "Crediario" };

const { perfil } = await requireAuth();
const ehAdm = perfil.role === "admin";
const root = initShell({ perfil, active: "vendas" });

const config = await getConfigSistema().catch(() => ({}));
const formasPagamento = config.formas_pagamento?.length
  ? config.formas_pagamento
  : ["dinheiro", "pix", "debito", "credito", "crediario"];

let filtroCanal = "";
let filtroForma = "";
let vendas = [];

root.innerHTML = `
  <div class="card">
    <div class="row">
      <select id="fcanal">
        <option value="">Todos os canais</option>
        ${Object.entries(CANAIS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        <option value="indicadores">Indicadores</option>
      </select>
      <select id="fforma">
        <option value="">Todas as formas de pagamento</option>
        ${formasPagamento.map((f) => `<option value="${f}">${FORMAS_LABEL[f] || f}</option>`).join("")}
      </select>
      <button class="btn" id="buscar">Atualizar</button>
    </div>
  </div>
  <div id="lista"><div class="card">Carregando...</div></div>`;

document.getElementById("buscar").onclick = () => {
  filtroCanal = document.getElementById("fcanal").value;
  filtroForma = document.getElementById("fforma").value;
  carregar();
};

carregar();

async function carregar() {
  const lista = document.getElementById("lista");
  lista.innerHTML = `<div class="card">Carregando...</div>`;
  try {
  if (filtroCanal === "indicadores") {
    await carregarTotalIndicadores(lista);
    return;
  }

  let q;
  if (ehAdm) {
    q = filtroCanal
      ? query(collection(db, "vendas"), where("canal", "==", filtroCanal), orderBy("data", "desc"), limit(200))
      : query(collection(db, "vendas"), orderBy("data", "desc"), limit(200));
  } else {
    q = query(collection(db, "vendas"), where("vendedor_uid", "==", perfil.id), orderBy("data", "desc"), limit(200));
  }

  vendas = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!ehAdm && filtroCanal) vendas = vendas.filter((v) => v.canal === filtroCanal);
  // Forma de pagamento e um filtro a mais, independente do canal (origem da
  // venda) — uma venda pode ter mais de uma forma (pagamento dividido), por
  // isso o filtro casa se QUALQUER uma das formas usadas bater.
  if (filtroForma) vendas = vendas.filter((v) => (v.pagamentos || []).some((p) => p.forma === filtroForma));

  document.getElementById("lista").innerHTML = `
    <div class="card">
      <div class="tabela-wrap"><table>
        <thead><tr>
          <th>#</th><th>Data</th><th>Canal</th><th>Vendedor</th><th class="right">Total</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${
            vendas
              .map(
                (v) => `<tr>
                  <td>${v.numero ?? (v.codigoRetirada ? escapeHtml(v.codigoRetirada) : "-")}</td>
                  <td>${fmtData(v.data)}</td>
                  <td>${CANAIS[v.canal] || v.canal}</td>
                  <td>${escapeHtml(v.vendedor_nome || "-")}</td>
                  <td class="right">${brl(v.total)}</td>
                  <td><span class="tag ${v.status}">${v.status}</span></td>
                  <td class="right"><button class="btn ghost ver" data-id="${v.id}">Ver</button></td>
                </tr>`
              )
              .join("") || `<tr><td colspan="7" class="muted">Nenhuma venda.</td></tr>`
          }
        </tbody>
      </table></div>
    </div>`;

  document.querySelectorAll(".ver").forEach(
    (b) => (b.onclick = () => detalhe(vendas.find((v) => v.id === b.dataset.id)))
  );
  } catch (e) {
    erroCard(lista, e, carregar);
  }
}

// Disponivel pra qualquer staff (admin ou vendedor ja podem ler qualquer
// pedido nas rules). Mostra so o total geral vendido pelos indicadores —
// o detalhamento por indicador fica na pagina Indicadores (so admin).
async function carregarTotalIndicadores(lista) {
  try {
    const [pedidosSnap, produtosSnap] = await Promise.all([
      getDocs(query(collection(db, "pedidos"), where("ref", "!=", ""))),
      getDocs(collection(db, "produtos")),
    ]);
    const produtosMap = new Map(produtosSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    const pedidos = pedidosSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => contaComoPago(p.status));

    let total = 0;
    for (const p of pedidos) total = round2(total + derivarItensPedido(p, produtosMap).subtotal);

    lista.innerHTML = `
      <div class="card">
        <strong>Vendas via indicadores (link ?ref= do site)</strong>
        <p class="muted">Soma de todos os pedidos do site com um indicador atribuido, pagos (aguardando pagamento e cancelados ficam de fora). Total derivado dos precos atuais do catalogo.</p>
        <div class="totais big"><span>Total vendido</span><span>${brl(total)}</span></div>
        <p class="muted">Pedidos considerados: ${pedidos.length}. Detalhamento por indicador em <a href="/indicadores">Indicadores</a>.</p>
      </div>`;
  } catch (e) {
    erroCard(lista, e, carregar);
  }
}

function detalhe(v) {
  const c = document.createElement("div");
  const infoCanal =
    v.canal === "site"
      ? `${v.codigoRetirada ? ` &middot; pedido <code>${escapeHtml(v.codigoRetirada)}</code>` : ""}` +
        `${v.cliente ? ` &middot; cliente ${escapeHtml(v.cliente)}` : ""}` +
        `${v.confirmado_por_nome ? ` &middot; retirada confirmada por ${escapeHtml(v.confirmado_por_nome)}` : ""}`
      : ` &middot; vendedor ${escapeHtml(v.vendedor_nome || "-")}`;
  c.innerHTML = `
    <p class="muted">${fmtData(v.data)} &middot; ${CANAIS[v.canal] || v.canal}${infoCanal}</p>
    ${
      v.canal !== "site" && (v.cliente || v.cliente_contato)
        ? `<p class="muted">Cliente: ${escapeHtml(v.cliente || "-")}${v.cliente_contato ? ` &middot; ${escapeHtml(v.cliente_contato)}` : ""}</p>`
        : ""
    }
    ${v.observacoes ? `<p class="muted">Obs: ${escapeHtml(v.observacoes)}</p>` : ""}
    ${
      v.canal === "site" && v.status === "concluida"
        ? `<p class="muted">Pedido do site entregue/retirado. Pra desfazer, cancele o pedido na tela Pedidos — isso devolve o estoque e atualiza aqui tambem.</p>`
        : ""
    }
    <table><tbody>
      ${(v.itens || [])
        .map((it) => `<tr><td>${it.qtd}x ${escapeHtml(it.nome)}</td><td class="right">${brl(it.subtotal)}</td></tr>`)
        .join("")}
    </tbody></table>
    <div class="totais"><span>Subtotal</span><span>${brl(v.subtotal)}</span></div>
    <div class="totais"><span>Desconto</span><span>- ${brl(v.desconto || 0)}</span></div>
    <div class="totais big"><span>Total</span><span>${brl(v.total)}</span></div>
    ${(v.pagamentos || [])
      .map((p) => `<div class="totais"><span>${p.forma}${p.parcelas > 1 ? ` (${p.parcelas}x de ${brl(p.valor_parcela)}${p.juros_pct ? `, ${p.juros_pct}% juros` : ""})` : ""}</span><span>${brl(p.valor)}</span></div>`)
      .join("")}
    ${
      v.comissao
        ? `<p class="muted">Comissao (${v.comissao.base}, ${v.comissao.percentual}%): ${brl(v.comissao.valor)} &mdash; ${v.comissao.status}</p>`
        : ""
    }`;

  const podeCancelar = ehAdm && v.status === "concluida" && v.canal !== "site";
  modal({
    titulo: `Venda ${v.numero != null ? "#" + v.numero : (v.codigoRetirada || "")}`,
    corpo: c,
    textoConfirmar: "Cancelar venda",
    textoCancelar: "Fechar",
    onConfirmar: podeCancelar
      ? async () => {
          if (!(await confirmar("Cancelar esta venda? O estoque dos itens sera devolvido.")))
            return false;
          await cancelar(v);
          toast("Venda cancelada.", "ok");
          carregar();
        }
      : null,
  });
}

async function cancelar(v) {
  await runTransaction(db, async (t) => {
    const vRef = doc(db, "vendas", v.id);
    const vSnap = await t.get(vRef);
    if (!vSnap.exists() || vSnap.data().status !== "concluida")
      throw new Error("Venda nao esta concluida.");

    const refs = (v.itens || []).map((it) => doc(db, "produtos", it.produtoId));
    const snaps = [];
    for (const r of refs) snaps.push(await t.get(r));

    t.update(vRef, {
      status: "cancelada",
      cancelada_em: serverTimestamp(),
      cancelada_por: perfil.id,
    });
    snaps.forEach((s, i) => {
      if (!s.exists()) return;
      const atual = s.data().estoque ?? 0;
      t.update(refs[i], {
        estoque: atual + v.itens[i].qtd,
        atualizadoEm: serverTimestamp(),
      });
    });
  });
}
