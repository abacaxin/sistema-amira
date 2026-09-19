// ── Regras puras da maquininha Point (sem rede, sem Firestore) ─────────
// Tudo aqui é função pura: valida a entrada do PDV, monta o corpo da order
// do Mercado Pago, interpreta a resposta e decide se um estado novo pode
// substituir o guardado. Fica separado dos handlers pra ser testável sem
// mock de nada (ver tests/point.test.js).

const { erroHttp } = require("./http");

const LIMITE_VALOR = 50000; // R$ por cobrança — trava contra erro de digitação
const MAX_PARCELAS = 12;
const TIPOS = ["credit_card", "debit_card"];
const QUEM_PAGA_JUROS = ["buyer", "seller"];

// A documentação do MP é inconsistente no nome deste campo: a página de
// processamento e a referência da API usam `installments_cost`; o guia de
// migração usa `default_installments_cost`. Usamos o primeiro (2 fontes).
// Se o Mercado Pago recusar no primeiro teste real, é só trocar aqui.
const CAMPO_QUEM_PAGA_JUROS = "installments_cost";

// Status da order: created → at_terminal → processed | failed | canceled |
// expired; processed → refunded. "criando"/"erro" são só nossos (antes de
// o MP responder / quando a criação falhou).
const STATUS_FINAIS = new Set(["processed", "failed", "canceled", "expired", "refunded"]);
const RANK = { criando: 0, erro: 0, created: 1, at_terminal: 2, action_required: 2 };

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function numero(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Valida e normaliza o corpo de POST /api/point/cobrar. Lança 400. */
function validarCobranca(b) {
  const corpo = b && typeof b === "object" ? b : {};

  const cobrancaId = String(corpo.cobrancaId || "");
  if (!/^[A-Za-z0-9_-]{8,60}$/.test(cobrancaId)) {
    throw erroHttp(400, "Identificador da cobrança inválido.");
  }

  const tipo = corpo.tipo;
  if (!TIPOS.includes(tipo)) {
    throw erroHttp(400, "Tipo de pagamento inválido (use crédito ou débito).");
  }

  const valorBruto = Number(corpo.valor);
  if (!Number.isFinite(valorBruto) || valorBruto <= 0) {
    throw erroHttp(400, "Valor da cobrança inválido.");
  }
  const centavos = Math.round(valorBruto * 100);
  if (centavos < 1) throw erroHttp(400, "Valor da cobrança inválido.");
  if (centavos > LIMITE_VALOR * 100) {
    throw erroHttp(400, `Valor acima do limite por cobrança (R$ ${LIMITE_VALOR}).`);
  }

  let parcelas = 1;
  let quemPagaJuros = null;
  if (tipo === "credit_card") {
    parcelas = corpo.parcelas === undefined || corpo.parcelas === null ? 1 : Number(corpo.parcelas);
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > MAX_PARCELAS) {
      throw erroHttp(400, `Número de parcelas inválido (1 a ${MAX_PARCELAS}).`);
    }
    // Padrão conservador: o cliente paga exatamente o preço, a loja absorve.
    if (corpo.quemPagaJuros === undefined || corpo.quemPagaJuros === null) quemPagaJuros = "seller";
    else if (QUEM_PAGA_JUROS.includes(corpo.quemPagaJuros)) quemPagaJuros = corpo.quemPagaJuros;
    else throw erroHttp(400, "Quem paga o juros deve ser o cliente ou a loja.");
  }

  return { cobrancaId, tipo, valor: centavos / 100, parcelas, quemPagaJuros };
}

/** Corpo do POST /v1/orders (Orders API, type "point"). */
function montarOrderPoint({ cobrancaId, tipo, valor, parcelas, quemPagaJuros, terminalId, descricao, expiraMin = 15 }) {
  const minutos = Math.min(180, Math.max(1, Math.trunc(Number(expiraMin)) || 15)); // MP aceita PT30S a PT3H
  return {
    type: "point",
    external_reference: cobrancaId, // ≤64 chars, [A-Za-z0-9_-], único — é o id do nosso documento
    expiration_time: `PT${minutos}M`,
    description: String(descricao || "Venda Amira").slice(0, 150),
    transactions: { payments: [{ amount: valor.toFixed(2) }] },
    config: {
      point: { terminal_id: terminalId, print_on_terminal: "no_ticket" },
      payment_method:
        tipo === "credit_card"
          ? { default_type: "credit_card", default_installments: parcelas, [CAMPO_QUEM_PAGA_JUROS]: quemPagaJuros }
          : { default_type: "debit_card" }
    }
  };
}

// O MP aceita o nome do campo de "quem paga o juros" em UM dos dois formatos
// (a doc usa os dois). Se recusar o primeiro com um 400 que fala desse
// campo, tentamos o outro UMA vez — assim o primeiro teste real não depende
// de saber qual está certo. Devolve o corpo com o nome trocado, ou null se
// o erro não tem a ver com isso.
const NOMES_QUEM_PAGA_JUROS = ["installments_cost", "default_installments_cost"];

function trocarCampoQuemPagaJuros(corpo, erro) {
  if (!erro || erro.mpStatus !== 400) return null;
  const pm = corpo && corpo.config && corpo.config.payment_method;
  if (!pm) return null;
  const atual = NOMES_QUEM_PAGA_JUROS.find((nome) => nome in pm);
  if (!atual) return null;
  const texto = `${JSON.stringify(erro.detalhe || "")} ${erro.message || ""}`;
  if (!new RegExp(atual, "i").test(texto)) return null; // o erro não fala desse campo
  const outro = NOMES_QUEM_PAGA_JUROS.find((nome) => nome !== atual);
  const { [atual]: valor, ...resto } = pm;
  return { ...corpo, config: { ...corpo.config, payment_method: { ...resto, [outro]: valor } } };
}

/**
 * Código do erro que o MP devolveu (ex.: "cannot_cancel_order",
 * "order_already_canceled"), ou "" se não veio. Os erros do MP chegam em
 * `errors[0].code`; alguns endpoints usam `code`/`error` na raiz.
 */
function codigoErroMp(erro) {
  const d = erro && erro.detalhe;
  const primeiro = d && Array.isArray(d.errors) ? d.errors[0] : null;
  return String((primeiro && primeiro.code) || (d && (d.code || d.error)) || "");
}

/** Terminais do MP → formato usado pela API/tela (id, modo, loja/caixa) marcando o configurado. */
function mapearTerminais(resposta, configurado) {
  const lista = (resposta && ((resposta.data && resposta.data.terminals) || resposta.terminals)) || [];
  const escolhido = String(configurado || "").trim();
  return lista.map((t) => ({
    id: t.id,
    modo: t.operating_mode || null,
    loja_id: t.store_id ?? null,
    caixa_id: t.pos_id ?? null,
    caixa_externo: t.external_pos_id || null,
    selecionado: Boolean(escolhido) && t.id === escolhido
  }));
}

function primeiroPagamento(order) {
  const lista = order && order.transactions && order.transactions.payments;
  return Array.isArray(lista) && lista.length ? lista[0] : null;
}

/**
 * Lê uma order do MP e devolve os campos (snake_case, como no Firestore)
 * que ELA informa. Campo que o MP não mandou fica null — quem grava
 * descarta os null, pra nunca apagar um dado bom por causa de uma resposta
 * mais pobre.
 */
function normalizarOrder(order) {
  const pg = primeiroPagamento(order) || {};
  const metodo = pg.payment_method || {};
  const status = String((order && order.status) || "");
  return {
    order_id: (order && order.id) || null,
    payment_id: pg.id || null,
    // Id do pagamento na API clássica (/v1/payments), se o MP mandar — é
    // por ele que dá pra buscar as taxas depois.
    payment_ref: pg.reference_id ? String(pg.reference_id) : null,
    status,
    status_detail: (order && order.status_detail) || null,
    // O motivo de verdade costuma estar no pagamento (ex.: "canceled_on_terminal",
    // "rejected_by_issuer"); o da order é mais genérico ("canceled", "failed").
    pagamento_detalhe: pg.status_detail || null,
    final: STATUS_FINAIS.has(status),
    aprovado: status === "processed",
    parcelas: numero(metodo.installments),
    metodo_tipo: metodo.type || null,
    bandeira: metodo.id || null,
    valor_pago: numero(pg.paid_amount)
  };
}

/**
 * Taxas REAIS cobradas pela maquininha, quando o MP as informa.
 *
 * O caminho principal é o pagamento da API clássica: `net_received_amount`
 * (o que cai na conta) e `fee_details` (as tarifas). Ordem de preferência
 * pro custo da loja: valor − líquido (é o dinheiro que de fato some); se não
 * houver líquido, soma das tarifas que NÃO são do comprador. Se nada disso
 * existir, tudo null e o PDV cai na estimativa da tabela de juros.
 *
 * @param {{valor:number, pagamentoOrder?:object, pagamentoClassico?:object}} p
 */
function extrairTaxas({ valor, pagamentoOrder, pagamentoClassico }) {
  const c = pagamentoClassico || {};
  const o = pagamentoOrder || {};
  const td = c.transaction_details || o.transaction_details || {};

  const liquido = numero(td.net_received_amount);
  const valorPago = numero(td.total_paid_amount) ?? numero(o.paid_amount);
  const base = numero(c.transaction_amount) ?? valor;

  let custo = null;
  if (liquido !== null && base !== null) {
    custo = round2(base - liquido);
  } else {
    const tarifas = c.fee_details || o.fee_details;
    if (Array.isArray(tarifas) && tarifas.length) {
      custo = round2(
        tarifas.filter((f) => f && f.fee_payer !== "payer").reduce((soma, f) => soma + (numero(f.amount) || 0), 0)
      );
    }
  }
  // Custo negativo = dado estranho; melhor não gravar do que inventar.
  if (custo !== null && custo < 0) custo = null;

  return {
    custo_loja: custo,
    liquido_mp: liquido,
    valor_pago: valorPago,
    taxa_origem: custo !== null ? "maquininha" : null
  };
}

/** Um estado novo pode substituir o guardado? Só avança (ou repete). */
function podeAvancar(atual, novo) {
  if (atual === novo) return true;
  // Estado final não muda — exceto aprovado → estornado.
  if (STATUS_FINAIS.has(atual)) return atual === "processed" && novo === "refunded";
  const rank = (s) => (STATUS_FINAIS.has(s) ? 3 : (RANK[s] ?? 1));
  return rank(novo) >= rank(atual);
}

/** Tira os null/undefined (não apagar dado bom com resposta pobre). */
function compactar(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

/** O que o PDV enxerga de uma cobrança (sem uid, sem resposta crua do MP). */
function projetarCobranca(d) {
  return compactar({
    cobranca_id: d.cobranca_id,
    status: d.status,
    status_detail: d.status_detail,
    pagamento_detalhe: d.pagamento_detalhe,
    final: Boolean(d.final),
    aprovado: Boolean(d.aprovado),
    estornada: d.status === "refunded",
    tipo: d.tipo,
    valor: d.valor,
    parcelas_solicitadas: d.parcelas_solicitadas,
    parcelas: d.parcelas,
    bandeira: d.bandeira,
    valor_pago: d.valor_pago,
    custo_loja: d.custo_loja,
    liquido_mp: d.liquido_mp,
    taxa_origem: d.taxa_origem,
    order_id: d.order_id,
    payment_id: d.payment_id,
    aviso: d.aviso
  });
}

module.exports = {
  LIMITE_VALOR,
  MAX_PARCELAS,
  CAMPO_QUEM_PAGA_JUROS,
  STATUS_FINAIS,
  round2,
  validarCobranca,
  montarOrderPoint,
  trocarCampoQuemPagaJuros,
  codigoErroMp,
  mapearTerminais,
  primeiroPagamento,
  normalizarOrder,
  extrairTaxas,
  podeAvancar,
  compactar,
  projetarCobranca
};
