const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validarCobranca,
  montarOrderPoint,
  normalizarOrder,
  extrairTaxas,
  podeAvancar,
  compactar,
  projetarCobranca,
  trocarCampoQuemPagaJuros,
  mapearTerminais,
  CAMPO_QUEM_PAGA_JUROS
} = require("../api/_lib/point");
const { papelDaEquipe } = require("../api/_lib/equipe");
const { aplicarCors, origensPermitidas } = require("../api/_lib/cors");
const { criarReq, criarRes } = require("./helpers/fakes");

const ID = "pdv-3f2a9c1e-0b7d-4a55-9d10-aaaaaaaaaaaa";

test("validarCobranca: crédito 3x normaliza valor, parcelas e quem paga o juros (padrão: loja)", () => {
  const r = validarCobranca({ cobrancaId: ID, tipo: "credit_card", valor: "105.999", parcelas: 3 });
  assert.deepEqual(r, { cobrancaId: ID, tipo: "credit_card", valor: 106, parcelas: 3, quemPagaJuros: "seller" });
});

test("validarCobranca: débito ignora parcelas e juros", () => {
  const r = validarCobranca({ cobrancaId: ID, tipo: "debit_card", valor: 50, parcelas: 6, quemPagaJuros: "buyer" });
  assert.deepEqual(r, { cobrancaId: ID, tipo: "debit_card", valor: 50, parcelas: 1, quemPagaJuros: null });
});

test("validarCobranca: recusa entradas ruins com 400", () => {
  const base = { cobrancaId: ID, tipo: "credit_card", valor: 10, parcelas: 1 };
  const ruins = [
    ["id curto", { ...base, cobrancaId: "abc" }],
    ["id com caractere inválido", { ...base, cobrancaId: "pdv id com espaço!!" }],
    ["tipo desconhecido", { ...base, tipo: "pix" }],
    ["valor zero", { ...base, valor: 0 }],
    ["valor negativo", { ...base, valor: -5 }],
    ["valor NaN", { ...base, valor: "abc" }],
    ["valor abaixo de 1 centavo", { ...base, valor: 0.001 }],
    ["valor acima do limite", { ...base, valor: 50000.01 }],
    ["parcelas 0", { ...base, parcelas: 0 }],
    ["parcelas 13", { ...base, parcelas: 13 }],
    ["parcelas fracionada", { ...base, parcelas: 2.5 }],
    ["quem paga inválido", { ...base, quemPagaJuros: "todos" }]
  ];
  for (const [nome, corpo] of ruins) {
    assert.throws(() => validarCobranca(corpo), (e) => e.status === 400 && Boolean(e.publico), nome);
  }
  assert.throws(() => validarCobranca(null), (e) => e.status === 400);
});

test("validarCobranca: aceita o limite exato", () => {
  assert.equal(validarCobranca({ cobrancaId: ID, tipo: "debit_card", valor: 50000 }).valor, 50000);
});

test("montarOrderPoint: crédito manda parcelas e quem paga o juros", () => {
  const o = montarOrderPoint({
    cobrancaId: ID, tipo: "credit_card", valor: 100, parcelas: 3, quemPagaJuros: "buyer",
    terminalId: "PAX_A910__SMARTPOS1", descricao: "Venda"
  });
  assert.equal(o.type, "point");
  assert.equal(o.external_reference, ID);
  assert.equal(o.expiration_time, "PT15M");
  assert.deepEqual(o.transactions.payments, [{ amount: "100.00" }]);
  assert.deepEqual(o.config.point, { terminal_id: "PAX_A910__SMARTPOS1", print_on_terminal: "no_ticket" });
  assert.deepEqual(o.config.payment_method, {
    default_type: "credit_card",
    default_installments: 3,
    [CAMPO_QUEM_PAGA_JUROS]: "buyer"
  });
});

test("montarOrderPoint: débito não manda parcelas; valor sempre com 2 casas", () => {
  const o = montarOrderPoint({ cobrancaId: ID, tipo: "debit_card", valor: 7.5, parcelas: 1, quemPagaJuros: null, terminalId: "T" });
  assert.deepEqual(o.config.payment_method, { default_type: "debit_card" });
  assert.equal(o.transactions.payments[0].amount, "7.50");
});

test("montarOrderPoint: expiração respeita o mínimo/máximo do MP (PT30S a PT3H)", () => {
  const base = { cobrancaId: ID, tipo: "debit_card", valor: 1, terminalId: "T" };
  assert.equal(montarOrderPoint({ ...base, expiraMin: 5 }).expiration_time, "PT5M");
  assert.equal(montarOrderPoint({ ...base, expiraMin: 9999 }).expiration_time, "PT180M");
  assert.equal(montarOrderPoint({ ...base, expiraMin: "lixo" }).expiration_time, "PT15M");
  assert.equal(montarOrderPoint({ ...base, expiraMin: undefined }).expiration_time, "PT15M");
});

test("montarOrderPoint: descrição é cortada em 150 caracteres", () => {
  const o = montarOrderPoint({ cobrancaId: ID, tipo: "debit_card", valor: 1, terminalId: "T", descricao: "x".repeat(400) });
  assert.equal(o.description.length, 150);
});

// ── trocarCampoQuemPagaJuros: plano B se o MP rejeitar o nome do campo ──
const corpoCredito = () =>
  montarOrderPoint({ cobrancaId: ID, tipo: "credit_card", valor: 100, parcelas: 3, quemPagaJuros: "buyer", terminalId: "T" });
const erroMp = (mpStatus, detalhe, message = "Mercado Pago POST /v1/orders -> HTTP 400") =>
  Object.assign(new Error(message), { status: 502, mpStatus, detalhe });

test("trocarCampoQuemPagaJuros: 400 que cita o campo → devolve o corpo com o outro nome e o mesmo valor", () => {
  const corpo = corpoCredito();
  assert.ok("installments_cost" in corpo.config.payment_method);
  const alt = trocarCampoQuemPagaJuros(corpo, erroMp(400, { errors: [{ message: "installments_cost is not allowed" }] }));
  assert.equal(alt.config.payment_method.default_installments_cost, "buyer");
  assert.equal("installments_cost" in alt.config.payment_method, false);
  // o resto do corpo não muda
  assert.equal(alt.config.payment_method.default_installments, 3);
  assert.equal(alt.config.payment_method.default_type, "credit_card");
  assert.deepEqual(alt.transactions, corpo.transactions);
  assert.deepEqual(alt.config.point, corpo.config.point);
});

test("trocarCampoQuemPagaJuros: também volta do nome alternativo pro original", () => {
  const alt = trocarCampoQuemPagaJuros(corpoCredito(), erroMp(400, { message: "installments_cost inválido" }));
  const volta = trocarCampoQuemPagaJuros(alt, erroMp(400, { message: "default_installments_cost inválido" }));
  assert.equal(volta.config.payment_method.installments_cost, "buyer");
  assert.equal("default_installments_cost" in volta.config.payment_method, false);
});

test("trocarCampoQuemPagaJuros: não muta o corpo original", () => {
  const corpo = corpoCredito();
  const antes = JSON.stringify(corpo);
  trocarCampoQuemPagaJuros(corpo, erroMp(400, { message: "installments_cost" }));
  assert.equal(JSON.stringify(corpo), antes);
});

test("trocarCampoQuemPagaJuros: só tenta de novo quando o erro é 400 E fala do campo", () => {
  const corpo = corpoCredito();
  assert.equal(trocarCampoQuemPagaJuros(corpo, erroMp(400, { message: "terminal not in PDV mode" })), null, "400 de outro assunto");
  assert.equal(trocarCampoQuemPagaJuros(corpo, erroMp(409, { message: "installments_cost" })), null, "não é 400");
  assert.equal(trocarCampoQuemPagaJuros(corpo, erroMp(500, { message: "installments_cost" })), null);
  assert.equal(trocarCampoQuemPagaJuros(corpo, new Error("rede caiu")), null, "erro sem mpStatus");
  assert.equal(trocarCampoQuemPagaJuros(corpo, null), null);
  assert.equal(trocarCampoQuemPagaJuros(corpo, undefined), null);
});

test("trocarCampoQuemPagaJuros: débito (sem o campo) ou corpo estranho nunca troca nada", () => {
  const debito = montarOrderPoint({ cobrancaId: ID, tipo: "debit_card", valor: 1, terminalId: "T" });
  assert.equal(trocarCampoQuemPagaJuros(debito, erroMp(400, { message: "installments_cost" })), null);
  assert.equal(trocarCampoQuemPagaJuros({}, erroMp(400, { message: "installments_cost" })), null);
  assert.equal(trocarCampoQuemPagaJuros(null, erroMp(400, { message: "installments_cost" })), null);
});

test("trocarCampoQuemPagaJuros: acha o campo também na mensagem do erro (sem detalhe JSON)", () => {
  const alt = trocarCampoQuemPagaJuros(corpoCredito(), erroMp(400, undefined, "HTTP 400: installments_cost inválido"));
  assert.equal(alt.config.payment_method.default_installments_cost, "buyer");
});

// ── mapearTerminais ──
test("mapearTerminais: aceita { data: { terminals } } e { terminals } e marca o configurado", () => {
  const t = [
    { id: "PAX_A910__1", operating_mode: "PDV", store_id: 11, pos_id: 22, external_pos_id: "CX1" },
    { id: "NEWLAND_N950__2", operating_mode: "STANDALONE", store_id: 11, pos_id: 23 }
  ];
  const esperado = [
    { id: "PAX_A910__1", modo: "PDV", loja_id: 11, caixa_id: 22, caixa_externo: "CX1", selecionado: true },
    { id: "NEWLAND_N950__2", modo: "STANDALONE", loja_id: 11, caixa_id: 23, caixa_externo: null, selecionado: false }
  ];
  assert.deepEqual(mapearTerminais({ data: { terminals: t } }, "PAX_A910__1"), esperado);
  assert.deepEqual(mapearTerminais({ terminals: t }, " PAX_A910__1 "), esperado, "ignora espaços no id configurado");
});

test("mapearTerminais: sem terminal configurado ninguém é selecionado; resposta vazia/estranha vira lista vazia", () => {
  const r = mapearTerminais({ data: { terminals: [{ id: "A__1" }] } }, "");
  assert.equal(r[0].selecionado, false);
  assert.equal(r[0].modo, null);
  assert.equal(r[0].loja_id, null);
  assert.deepEqual(mapearTerminais({}, "X"), []);
  assert.deepEqual(mapearTerminais(null, "X"), []);
  assert.deepEqual(mapearTerminais({ data: {} }, undefined), []);
});

test("normalizarOrder: order criada", () => {
  const n = normalizarOrder({
    id: "ORD1", status: "created", status_detail: "created",
    transactions: { payments: [{ id: "PAY1", amount: "24.00", status: "created" }] }
  });
  assert.equal(n.order_id, "ORD1");
  assert.equal(n.payment_id, "PAY1");
  assert.equal(n.status, "created");
  assert.equal(n.final, false);
  assert.equal(n.aprovado, false);
  assert.equal(n.parcelas, null);
  assert.equal(n.valor_pago, null);
});

test("normalizarOrder: order aprovada traz parcelas, bandeira e valor pago", () => {
  const n = normalizarOrder({
    id: "ORD1", status: "processed", status_detail: "accredited",
    transactions: {
      payments: [{
        id: "PAY1", amount: "100.00", paid_amount: "105.30", status: "processed", reference_id: 123456789,
        payment_method: { id: "master", type: "credit_card", installments: 3 }
      }]
    }
  });
  assert.equal(n.aprovado, true);
  assert.equal(n.final, true);
  assert.equal(n.parcelas, 3);
  assert.equal(n.bandeira, "master");
  assert.equal(n.metodo_tipo, "credit_card");
  assert.equal(n.valor_pago, 105.3);
  assert.equal(n.payment_ref, "123456789");
});

test("normalizarOrder: status finais", () => {
  for (const s of ["processed", "failed", "canceled", "expired", "refunded"]) {
    assert.equal(normalizarOrder({ id: "O", status: s }).final, true, s);
  }
  for (const s of ["created", "at_terminal", "action_required"]) {
    assert.equal(normalizarOrder({ id: "O", status: s }).final, false, s);
  }
});

test("normalizarOrder: resposta vazia/esquisita não estoura", () => {
  assert.equal(normalizarOrder({}).status, "");
  assert.equal(normalizarOrder(null).order_id, null);
  assert.equal(normalizarOrder({ transactions: { payments: [] } }).payment_id, null);
});

test("extrairTaxas: usa o líquido do MP (custo = valor − líquido)", () => {
  const t = extrairTaxas({
    valor: 100,
    pagamentoClassico: {
      transaction_amount: 100,
      transaction_details: { net_received_amount: 94.69, total_paid_amount: 114.31 },
      fee_details: [{ type: "mercadopago_fee", amount: 5.31, fee_payer: "collector" }]
    }
  });
  assert.deepEqual(t, { custo_loja: 5.31, liquido_mp: 94.69, valor_pago: 114.31, taxa_origem: "maquininha" });
});

test("extrairTaxas: sem líquido, soma só as tarifas que a loja paga", () => {
  const t = extrairTaxas({
    valor: 100,
    pagamentoClassico: {
      fee_details: [
        { type: "mercadopago_fee", amount: 4.5, fee_payer: "collector" },
        { type: "financing_fee", amount: 3, fee_payer: "payer" },
        { type: "outra", amount: 1 }
      ]
    }
  });
  assert.equal(t.custo_loja, 5.5);
  assert.equal(t.liquido_mp, null);
  assert.equal(t.taxa_origem, "maquininha");
});

test("extrairTaxas: sem nenhum dado, tudo null (o PDV cai na estimativa)", () => {
  assert.deepEqual(extrairTaxas({ valor: 100 }), { custo_loja: null, liquido_mp: null, valor_pago: null, taxa_origem: null });
});

test("extrairTaxas: custo negativo é descartado em vez de inventado", () => {
  const t = extrairTaxas({ valor: 100, pagamentoClassico: { transaction_details: { net_received_amount: 120 } } });
  assert.equal(t.custo_loja, null);
  assert.equal(t.taxa_origem, null);
  assert.equal(t.liquido_mp, 120);
});

test("extrairTaxas: valor pago cai pro paid_amount da order se a API clássica não disser", () => {
  const t = extrairTaxas({ valor: 100, pagamentoOrder: { paid_amount: "100.00" } });
  assert.equal(t.valor_pago, 100);
});

test("podeAvancar: só avança, nunca regride", () => {
  const ok = [
    ["criando", "created"], ["created", "at_terminal"], ["at_terminal", "processed"],
    ["created", "processed"], ["at_terminal", "failed"], ["at_terminal", "canceled"], ["created", "expired"],
    ["processed", "refunded"], ["erro", "created"], ["action_required", "at_terminal"],
    ["at_terminal", "at_terminal"], ["processed", "processed"]
  ];
  for (const [a, n] of ok) assert.equal(podeAvancar(a, n), true, `${a} → ${n}`);

  const ruins = [
    ["at_terminal", "created"], ["at_terminal", "criando"],
    ["processed", "at_terminal"], ["processed", "failed"], ["processed", "canceled"],
    ["failed", "processed"], ["canceled", "processed"], ["expired", "at_terminal"],
    ["refunded", "processed"], ["refunded", "at_terminal"], ["failed", "refunded"]
  ];
  for (const [a, n] of ruins) assert.equal(podeAvancar(a, n), false, `${a} → ${n}`);
});

test("compactar tira null/undefined e mantém 0 e false", () => {
  assert.deepEqual(compactar({ a: 1, b: null, c: undefined, d: 0, e: false, f: "" }), { a: 1, d: 0, e: false, f: "" });
});

test("projetarCobranca não vaza uid, resposta crua do MP nem campos internos", () => {
  const p = projetarCobranca({
    cobranca_id: ID, status: "processed", final: true, aprovado: true, tipo: "credit_card", valor: 100,
    parcelas: 3, bandeira: "visa", valor_pago: 100, custo_loja: 4, taxa_origem: "maquininha",
    order_id: "ORD1", payment_id: "PAY1",
    vendedor_uid: "segredo", vendedor_nome: "Vera", terminal_id: "T", mp_raw: { x: 1 }, mp_pagamento_raw: { y: 2 }, erro: "interno"
  });
  assert.equal(p.status, "processed");
  assert.equal(p.estornada, false);
  for (const proibido of ["vendedor_uid", "vendedor_nome", "terminal_id", "mp_raw", "mp_pagamento_raw", "erro"]) {
    assert.equal(proibido in p, false, proibido);
  }
  assert.equal(projetarCobranca({ cobranca_id: ID, status: "refunded" }).estornada, true);
});

test("papelDaEquipe espelha as firestore.rules", () => {
  assert.equal(papelDaEquipe({ role: "admin" }), "admin");
  assert.equal(papelDaEquipe({ role: "admin", ativo: false }), "admin"); // ehAdmin() não olha ativo
  assert.equal(papelDaEquipe({ role: "vendedor", ativo: true }), "vendedor");
  assert.equal(papelDaEquipe({ role: "vendedor", ativo: false }), null);
  assert.equal(papelDaEquipe({ role: "vendedor" }), null);
  assert.equal(papelDaEquipe({ role: "cliente" }), null);
  assert.equal(papelDaEquipe(null), null);
});

test("CORS: só as origens da lista recebem os headers; preflight responde 204", () => {
  const env = { CORS_ORIGINS: "https://a.example, https://b.example/" };
  assert.deepEqual(origensPermitidas(env), ["https://a.example", "https://b.example"]);

  const res1 = criarRes();
  assert.equal(aplicarCors(criarReq({ headers: { origin: "https://a.example" } }), res1, env), false);
  assert.equal(res1.headers["access-control-allow-origin"], "https://a.example");
  assert.equal(res1.headers.vary, "Origin");

  const res2 = criarRes();
  aplicarCors(criarReq({ headers: { origin: "https://evil.example" } }), res2, env);
  assert.equal("access-control-allow-origin" in res2.headers, false);

  const res3 = criarRes();
  assert.equal(aplicarCors(criarReq({ method: "OPTIONS", headers: { origin: "https://a.example" } }), res3, env), true);
  assert.equal(res3.statusCode, 204);
  assert.equal(res3.terminou, true);
});

test("CORS: sem CORS_ORIGINS usa as origens padrão do sistema", () => {
  const padrao = origensPermitidas({});
  assert.ok(padrao.includes("https://flora-5754a-interno.web.app"));
  assert.ok(padrao.includes("http://localhost:5173"));
});
