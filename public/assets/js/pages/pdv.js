import { requireAuth } from "../auth.js";
import { initShell, toast, escapeHtml, erroCard } from "../ui.js";
import {
  db, collection, getDocs, query, where,
  doc, runTransaction, serverTimestamp, getConfigSistema,
} from "../db.js";
import { brl, round2, parseNum } from "../money.js";
import { calcularComissao } from "../regras.js";
import { infoPreco, estoquePorModo } from "../produtos-schema.js";
import { FORMAS_JUROS, FORMAS_PARCELAVEIS, parcelasDisponiveis, taxasDe, infoParcela } from "../juros.js";

const { perfil } = await requireAuth();
const root = initShell({ perfil, active: "pdv" });
root.innerHTML = `<div class="card">Carregando...</div>`;

try {
const config = await getConfigSistema();
const formas = config.formas_pagamento?.length
  ? config.formas_pagamento
  : ["dinheiro", "pix", "debito", "credito", "crediario"];
const parc = config.parcelamento || { maximo: 12, minimo_parcela: 0, juros: {} };

// Caixa e UNICO pra loja toda — nao e "do usuario logado". Qualquer
// vendedor/admin vende contra o mesmo caixa aberto, seja quem for que
// abriu de manha.
const caixaDoc = (await getDocs(query(
  collection(db, "caixa"),
  where("status", "==", "aberto")
))).docs[0];
const caixaAbertoId = caixaDoc ? caixaDoc.id : null;

// produtos vendaveis (schema do site: `ativo`; ordena/filtra em memoria pra
// nao depender de indice composto)
const produtos = (await getDocs(collection(db, "produtos"))).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((p) => p.ativo !== false)
  .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

// preco de venda (varejo, com desconto do site aplicado); estoque e um so
// pool (nao ha mais divisao varejo/atacado)
const precoDe = (p) => infoPreco(p, "varejo").precoFinal;
const estoqueDe = (p) => estoquePorModo(p);

let carrinho = [];
let pagamentos = [];

root.innerHTML = `
  <div class="grid auto">
    <div class="card">
      <strong>Produtos</strong>
      ${caixaAbertoId ? "" : `<p style="color:var(--warn)">Nenhum caixa aberto &mdash; vendas em dinheiro ficam bloqueadas. <a href="/caixa">Abrir caixa</a></p>`}
      <label style="margin-top:8px">Bipar codigo de barras</label>
      <input id="bipar" placeholder="Encoste o leitor e bipe o produto" autocomplete="off" inputmode="numeric">
      <input id="busca-prod" placeholder="Ou buscar por nome / codigo" style="margin-top:8px">
      <div id="resultados" style="margin-top:10px;max-height:58vh;overflow:auto"></div>
    </div>
    <div class="card">
      <strong>Venda</strong>
      <label>Cliente</label><input id="cliente" placeholder="Nome do cliente" required>
      <label>Contato</label><input id="cliente-contato" placeholder="Telefone / WhatsApp" required>
      <label>Observacoes (opcional)</label>
      <textarea id="observacoes" rows="2" placeholder="Ex.: embrulho pra presente, retirar as 18h..."></textarea>
      <div id="cart" style="margin-top:10px"></div>
      <label>Desconto (R$)</label><input id="desconto" value="0" inputmode="decimal">
      <label>Pagamentos</label>
      <div id="pags"></div>
      <button class="btn ghost" id="add-pag" style="margin-top:6px">+ Forma de pagamento</button>
      <div id="totais" style="margin-top:12px"></div>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="finalizar">Finalizar venda</button>
        <button class="btn ghost" id="limpar">Limpar</button>
      </div>
    </div>
  </div>`;

const $ = (s) => root.querySelector(s);

$("#busca-prod").oninput = renderResultados;
$("#bipar").focus();
$("#bipar").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  bipar($("#bipar").value.trim());
  $("#bipar").value = "";
};
$("#desconto").oninput = renderTotais;
$("#add-pag").onclick = () => {
  const { total, pago } = calc();
  pagamentos.push({ forma: formas[0], valor: round2(Math.max(0, total - pago)), parcelas: 1 });
  renderPags();
  renderTotais();
};
$("#limpar").onclick = limpar;
$("#finalizar").onclick = finalizar;

renderResultados();
renderCart();
renderPags();
renderTotais();

function renderResultados() {
  const termo = $("#busca-prod").value.toLowerCase().trim();
  const lista = produtos
    .filter(
      (p) =>
        !termo ||
        (p.nome || "").toLowerCase().includes(termo) ||
        (p.sku || "").toLowerCase().includes(termo) ||
        (p.codigoBarras || "").toLowerCase().includes(termo)
    )
    .slice(0, 40);
  $("#resultados").innerHTML =
    lista
      .map(
        (p) => `<div class="cart-line">
          <div class="nm">
            <div>${escapeHtml(p.nome)}</div>
            <div class="muted">${escapeHtml(p.codigoBarras || p.sku || "")} &middot; ${brl(precoDe(p))} &middot; estoque ${estoqueDe(p)}</div>
          </div>
          <button class="btn sec add" data-id="${p.id}" ${estoqueDe(p) <= 0 ? "disabled" : ""}>Add</button>
        </div>`
      )
      .join("") || `<p class="muted">Nada encontrado.</p>`;
  $("#resultados")
    .querySelectorAll(".add")
    .forEach((b) => (b.onclick = () => addItem(b.dataset.id)));
}

function bipar(codigo) {
  if (!codigo) return;
  const p = produtos.find((x) => (x.codigoBarras || "") === codigo);
  if (!p) return toast(`Codigo ${codigo} nao encontrado (produto inativo?).`, "warn");
  addItem(p.id);
  $("#bipar").focus();
}

function addItem(id) {
  const p = produtos.find((x) => x.id === id);
  const linha = carrinho.find((l) => l.produtoId === id);
  const qAtual = linha ? linha.qtd : 0;
  if (qAtual + 1 > estoqueDe(p)) return toast("Estoque insuficiente.", "warn");
  if (linha) linha.qtd++;
  else
    carrinho.push({
      produtoId: id,
      sku: p.sku || "",
      codigoBarras: p.codigoBarras || "",
      nome: p.nome,
      preco_unit: precoDe(p),
      preco_custo: 0, // catalogo do site nao guarda custo
      qtd: 1,
    });
  renderCart();
  renderTotais();
}

function renderCart() {
  $("#cart").innerHTML =
    carrinho
      .map(
        (l, i) => `<div class="cart-line">
          <div class="nm">${escapeHtml(l.nome)}<div class="muted">${brl(l.preco_unit)}</div></div>
          <input type="number" min="1" value="${l.qtd}" data-i="${i}" class="q">
          <div style="width:84px;text-align:right">${brl(l.preco_unit * l.qtd)}</div>
          <button class="btn ghost rm" data-i="${i}">&times;</button>
        </div>`
      )
      .join("") || `<p class="muted">Carrinho vazio.</p>`;

  $("#cart")
    .querySelectorAll(".q")
    .forEach((inp) => {
      inp.onchange = () => {
        const i = +inp.dataset.i;
        const q = Math.max(1, Math.trunc(+inp.value || 1));
        const p = produtos.find((x) => x.id === carrinho[i].produtoId);
        if (q > estoqueDe(p)) {
          toast("Estoque insuficiente.", "warn");
          inp.value = carrinho[i].qtd;
          return;
        }
        carrinho[i].qtd = q;
        renderCart();
        renderTotais();
      };
    });
  $("#cart")
    .querySelectorAll(".rm")
    .forEach((b) => {
      b.onclick = () => {
        carrinho.splice(+b.dataset.i, 1);
        renderCart();
        renderTotais();
      };
    });
}

function renderPags() {
  $("#pags").innerHTML = pagamentos
    .map((pg, i) => {
      const parcelavel = FORMAS_PARCELAVEIS.has(pg.forma);
      let linhaParcelas = "";
      if (parcelavel) {
        const opcoes = parcelasDisponiveis(pg.valor, parc);
        const numParcelas = opcoes.includes(pg.parcelas) ? pg.parcelas : 1;
        pg.parcelas = numParcelas;
        linhaParcelas = `
          <div class="cart-line">
            <select data-i="${i}" class="pp">
              ${opcoes
                .map((n) => {
                  const j = taxasDe(config, pg.forma, n).cliente;
                  return `<option value="${n}" ${n === numParcelas ? "selected" : ""}>${n}x${j ? ` (${j}% juros)` : " sem juros"}</option>`;
                })
                .join("")}
            </select>
          </div>`;
      }
      // Mostra a taxa do CLIENTE (somada ao que ele paga) e da LOJA (custo de
      // maquininha/financiamento, descontado do que a loja recebe) pra
      // qualquer forma em FORMAS_JUROS — inclusive debito, que nao parcela
      // mas pode ter taxa a vista configurada em "1". Sem isso o vendedor nao
      // tinha como ver o custo da loja antes de finalizar a venda.
      let linhaTaxa = "";
      if (FORMAS_JUROS.includes(pg.forma)) {
        const { pctCliente, pctLoja, valorComJuros, custoLoja, valorParcela, parcelas } = infoPagamento(pg);
        const partes = pctCliente || pctLoja
          ? [
              parcelavel && parcelas > 1 ? `${parcelas}x de ${brl(valorParcela)}` : "",
              `cliente: ${pctCliente ? `+${pctCliente}% (total ${brl(valorComJuros)})` : "sem juros"}`,
              `loja: ${pctLoja ? `-${pctLoja}% (${brl(custoLoja)} de custo)` : "sem custo"}`,
            ].filter(Boolean)
          : [`sem taxa configurada pra ${pg.forma}${parcelavel ? ` em ${pg.parcelas}x` : ""} — ajuste em Configuracoes`];
        linhaTaxa = `<p class="muted" style="margin:2px 0 8px;font-size:12px">${partes.join(" &middot; ")}</p>`;
      }
      return `<div class="cart-line">
        <select data-i="${i}" class="pf">${formas
          .map((f) => `<option ${f === pg.forma ? "selected" : ""}>${f}</option>`)
          .join("")}</select>
        <input class="pv" data-i="${i}" value="${pg.valor}" inputmode="decimal" style="width:120px">
        <button class="btn ghost prm" data-i="${i}">&times;</button>
      </div>${linhaParcelas}${linhaTaxa}`;
    })
    .join("");
  $("#pags")
    .querySelectorAll(".pf")
    .forEach(
      (s) =>
        (s.onchange = () => {
          const pg = pagamentos[+s.dataset.i];
          pg.forma = s.value;
          pg.parcelas = 1;
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pv")
    .forEach(
      (inp) =>
        (inp.onchange = () => {
          pagamentos[+inp.dataset.i].valor = round2(parseNum(inp.value));
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".pp")
    .forEach(
      (s) =>
        (s.onchange = () => {
          pagamentos[+s.dataset.i].parcelas = Math.trunc(+s.value) || 1;
          renderPags();
          renderTotais();
        })
    );
  $("#pags")
    .querySelectorAll(".prm")
    .forEach((b) => {
      b.onclick = () => {
        pagamentos.splice(+b.dataset.i, 1);
        renderPags();
        renderTotais();
      };
    });
}

function calc() {
  const subtotal = round2(carrinho.reduce((s, l) => s + l.preco_unit * l.qtd, 0));
  const desconto = Math.max(0, round2(parseNum($("#desconto").value)));
  const total = round2(subtotal - desconto);
  // `pago` continua validando contra o valor ORIGINAL (pg.valor) de cada
  // forma — o juros do cliente e um acrescimo no que a maquininha cobra,
  // nao muda quanto do total da venda aquela forma "cobre". Isso mantem a
  // validacao pago===total intacta mesmo com juros de verdade.
  const pago = round2(pagamentos.reduce((s, p) => s + (p.valor || 0), 0));
  return { subtotal, desconto, total, pago };
}

// Info completa de juros pra um pagamento — mesma regra usada em renderPags,
// no preview do total e na hora de gravar a venda: forma parcelavel usa a
// quantidade escolhida, as demais (ex.: debito) usam sempre 1x.
function infoPagamento(p) {
  const parcelas = FORMAS_PARCELAVEIS.has(p.forma) ? Math.max(1, Math.trunc(p.parcelas) || 1) : 1;
  return { parcelas, ...infoParcela(p.valor || 0, parcelas, taxasDe(config, p.forma, parcelas)) };
}

// pg.valor continua sendo o valor ORIGINAL (de tabela) alocado pra essa
// forma — os campos de juros abaixo sao aditivos, pra nao mexer em nada que
// ja le `valor`/`total` da venda (comissao do vendedor, listagem de Vendas,
// dashboard, relatorios). So grava os campos de juros quando ha taxa
// configurada pra essa forma+parcelas (cobre credito/crediario parcelado E
// credito/debito a vista com taxa de maquininha). Usada tanto no preview
// (renderTotais) quanto ao finalizar, pra nunca divergir do que e salvo.
function pagamentosComJuros(pags) {
  return pags.map((p) => {
    const valor = round2(p.valor);
    const base = { forma: p.forma, valor };
    if (!FORMAS_JUROS.includes(p.forma)) return base;
    const { parcelas, pctCliente, pctLoja, valorComJuros, custoLoja, valorLiquido, valorParcela } = infoPagamento(p);
    if (!pctCliente && !pctLoja) return base;
    return {
      ...base,
      ...(FORMAS_PARCELAVEIS.has(p.forma) && parcelas > 1 ? { parcelas, valor_parcela: valorParcela } : {}),
      juros_pct: pctCliente,
      pct_loja: pctLoja,
      valor_com_juros: valorComJuros,
      custo_loja: custoLoja,
      valor_liquido: valorLiquido,
    };
  });
}

function agregarJuros(pagsComJuros) {
  const totalComJuros = round2(pagsComJuros.reduce((s, p) => s + (p.valor_com_juros ?? p.valor), 0));
  const custoLojaTotal = round2(pagsComJuros.reduce((s, p) => s + (p.custo_loja || 0), 0));
  const valorLiquido = round2(pagsComJuros.reduce((s, p) => s + (p.valor_liquido ?? p.valor), 0));
  return { totalComJuros, custoLojaTotal, valorLiquido };
}

function renderTotais() {
  const { subtotal, desconto, total, pago } = calc();
  const falta = round2(total - pago);
  const { totalComJuros, custoLojaTotal, valorLiquido } = agregarJuros(pagamentosComJuros(pagamentos));
  $("#totais").innerHTML = `
    <div class="totais"><span>Subtotal</span><span>${brl(subtotal)}</span></div>
    <div class="totais"><span>Desconto</span><span>- ${brl(desconto)}</span></div>
    <div class="totais big"><span>Total</span><span>${brl(total)}</span></div>
    ${totalComJuros !== total ? `<div class="totais"><span>Total com juros (a cobrar do cliente)</span><span>${brl(totalComJuros)}</span></div>` : ""}
    ${custoLojaTotal > 0 ? `<div class="totais"><span>Custo da loja (maquininha/financiamento)</span><span>- ${brl(custoLojaTotal)}</span></div>` : ""}
    ${custoLojaTotal > 0 ? `<div class="totais"><span>Valor liquido estimado</span><span>${brl(valorLiquido)}</span></div>` : ""}
    <div class="totais"><span>Pago</span><span>${brl(pago)}</span></div>
    <div class="totais"><span>${falta > 0 ? "Falta" : falta < 0 ? "Troco" : "&mdash;"}</span><span>${brl(Math.abs(falta))}</span></div>`;
}

function limpar() {
  carrinho = [];
  pagamentos = [];
  $("#cliente").value = "";
  $("#cliente-contato").value = "";
  $("#observacoes").value = "";
  $("#desconto").value = "0";
  renderResultados();
  renderCart();
  renderPags();
  renderTotais();
}

async function finalizar() {
  if (!carrinho.length) return toast("Carrinho vazio.", "warn");
  if (!$("#cliente").value.trim()) return toast("Informe o nome do cliente.", "err");
  if (!$("#cliente-contato").value.trim()) return toast("Informe o contato do cliente.", "err");
  const { subtotal, desconto, total, pago } = calc();
  if (total < 0) return toast("Desconto maior que o subtotal.", "err");
  if (round2(pago) !== total)
    return toast(`Pagamentos (${brl(pago)}) diferentes do total (${brl(total)}).`, "err");
  const temDinheiro = pagamentos.some((p) => p.forma === "dinheiro" && p.valor > 0);
  if (temDinheiro && !caixaAbertoId)
    return toast("Abra o caixa para receber em dinheiro.", "err");

  const btn = $("#finalizar");
  btn.disabled = true;
  try {
    const itensVenda = carrinho.map((l) => ({
      produtoId: l.produtoId,
      sku: l.sku,
      codigoBarras: l.codigoBarras,
      nome: l.nome,
      qtd: l.qtd,
      preco_unit: round2(l.preco_unit),
      preco_custo: round2(l.preco_custo || 0),
      subtotal: round2(l.preco_unit * l.qtd),
    }));
    const comissao = calcularComissao({ itens: itensVenda, subtotal, total, config, perfil });
    const cliente = $("#cliente").value.trim() || null;
    const clienteContato = $("#cliente-contato").value.trim() || null;
    const observacoes = $("#observacoes").value.trim() || null;
    const pagamentosSalvos = pagamentosComJuros(pagamentos);
    const { totalComJuros, custoLojaTotal, valorLiquido } = agregarJuros(pagamentosSalvos);

    const numero = await runTransaction(db, async (t) => {
      const contRef = doc(db, "contadores", "vendas");
      const contSnap = await t.get(contRef);
      const prox = (contSnap.exists() ? contSnap.data().ultimo_numero || 0 : 0) + 1;

      const estoques = [];
      for (const it of itensVenda) {
        const ref = doc(db, "produtos", it.produtoId);
        const s = await t.get(ref);
        if (!s.exists()) throw new Error(`Produto ${it.nome} nao encontrado.`);
        const est = s.data().estoque ?? 0;
        if (est < it.qtd) throw new Error(`Estoque insuficiente de ${it.nome} (disponivel: ${est}).`);
        estoques.push({ ref, novo: est - it.qtd });
      }

      t.set(contRef, { ultimo_numero: prox }, { merge: true });
      // Regra do site: um vendedor so pode alterar `estoque`/`atualizadoEm`
      // em produtos — nada mais nesse update.
      estoques.forEach((e) =>
        t.update(e.ref, {
          estoque: e.novo,
          atualizadoEm: serverTimestamp(),
        })
      );
      t.set(doc(collection(db, "vendas")), {
        numero: prox,
        canal: "loja",
        data: serverTimestamp(),
        criado_em: serverTimestamp(),
        vendedor_uid: perfil.id,
        vendedor_nome: perfil.nome || "",
        cliente,
        cliente_contato: clienteContato,
        observacoes,
        itens: itensVenda,
        subtotal,
        desconto,
        total,
        total_com_juros: totalComJuros,
        custo_loja_total: custoLojaTotal,
        valor_liquido: valorLiquido,
        pagamentos: pagamentosSalvos,
        status: "concluida",
        caixa_id: caixaAbertoId || null,
        comissao,
      });
      return prox;
    });

    toast(`Venda #${numero} registrada.`, "ok");
    recibo({ numero, itens: itensVenda, subtotal, desconto, total, totalComJuros, pagamentos: pagamentosSalvos, cliente, clienteContato, observacoes });

    // atualiza estoque em memoria
    itensVenda.forEach((it) => {
      const p = produtos.find((x) => x.id === it.produtoId);
      if (p) p.estoque = estoqueDe(p) - it.qtd;
    });
    limpar();
  } catch (e) {
    toast(e?.message || "Falha ao registrar venda.", "err");
  } finally {
    btn.disabled = false;
  }
}

function recibo(v) {
  const w = window.open("", "_blank", "width=360,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Venda #${v.numero}</title>
  <body style="font-family:system-ui;padding:16px;font-size:13px;color:#2b2430">
    <h3 style="margin:0">${escapeHtml(config.nome_loja || "Amira")}</h3>
    <div>Venda #${v.numero} &mdash; ${new Date().toLocaleString("pt-BR")}</div>
    <div>Vendedor: ${escapeHtml(perfil.nome || "")}</div>
    ${v.cliente ? `<div>Cliente: ${escapeHtml(v.cliente)}</div>` : ""}
    ${v.clienteContato ? `<div>Contato: ${escapeHtml(v.clienteContato)}</div>` : ""}
    ${v.observacoes ? `<div>Obs: ${escapeHtml(v.observacoes)}</div>` : ""}
    <hr>
    <table style="width:100%;border-collapse:collapse">
      ${v.itens
        .map(
          (it) =>
            `<tr><td>${it.qtd}x ${escapeHtml(it.nome)}</td><td style="text-align:right">${brl(it.subtotal)}</td></tr>`
        )
        .join("")}
    </table>
    <hr>
    <div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${brl(v.subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>Desconto</span><span>- ${brl(v.desconto)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:700"><span>Total</span><span>${brl(v.total)}</span></div>
    ${v.totalComJuros && v.totalComJuros !== v.total ? `<div style="display:flex;justify-content:space-between;font-weight:700"><span>Total com juros</span><span>${brl(v.totalComJuros)}</span></div>` : ""}
    ${v.pagamentos
      .map(
        (p) =>
          `<div style="display:flex;justify-content:space-between"><span>${p.forma}${p.parcelas > 1 ? ` (${p.parcelas}x de ${brl(p.valor_parcela)})` : ""}</span><span>${brl(p.valor_com_juros ?? p.valor)}</span></div>`
      )
      .join("")}
    <hr>
    <div style="text-align:center">Obrigada pela preferencia!</div>
    <button onclick="window.print()" style="margin-top:12px;width:100%;padding:8px">Imprimir</button>
  </body>`);
  w.document.close();
}
} catch (e) {
  erroCard(root, e);
}
