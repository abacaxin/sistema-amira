const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { criarHandlers, checarAssinatura } = require("../api/_lib/point-handlers");
const { erroHttp } = require("../api/_lib/http");
const { criarFakeDb, criarReq, criarRes, criarMpFalso } = require("./helpers/fakes");

const ID = "pdv-3f2a9c1e-0b7d-4a55-9d10-aaaaaaaaaaaa";
const ID2 = "pdv-77777777-0b7d-4a55-9d10-bbbbbbbbbbbb";
const TERMINAL = "PAX_A910__SMARTPOS123";

const VENDEDORA = { uid: "u-vera", email: "vera@x", role: "vendedor", nome: "Vera" };
const OUTRO = { uid: "u-caio", email: "caio@x", role: "vendedor", nome: "Caio" };
const ADMIN = { uid: "u-dono", email: "dono@x", role: "admin", nome: "Dono" };
const TOKENS = { "tok-vera": VENDEDORA, "tok-caio": OUTRO, "tok-dono": ADMIN };

function montar({ env = {}, mp = criarMpFalso(), db = criarFakeDb() } = {}) {
  const handlers = criarHandlers({
    getDb: () => db,
    exigirStaff: async (token) => {
      if (!TOKENS[token]) throw erroHttp(401, "Sessão expirada. Entre de novo no sistema para continuar.");
      return TOKENS[token];
    },
    exigirAdmin: async (token) => {
      if (!TOKENS[token]) throw erroHttp(401, "Sessão expirada. Entre de novo no sistema para continuar.");
      if (TOKENS[token].role !== "admin") throw erroHttp(403, "Só administradores podem fazer isso.");
      return TOKENS[token];
    },
    mp,
    limitar: async () => {},
    tokenDaRequisicao: (req) => String((req.headers.authorization || "").replace(/^Bearer\s+/i, "")),
    env: { MP_POINT_TERMINAL_ID: TERMINAL, ...env },
    agora: () => new Date("2026-09-19T12:00:00Z")
  });
  return { db, mp, handlers };
}

const chamar = async (handler, req) => {
  const res = criarRes();
  await handler(req, res);
  return res;
};
const post = (token, body, extra = {}) =>
  criarReq({ method: "POST", headers: { authorization: `Bearer ${token}` }, body, ...extra });
const get = (token, query, extra = {}) =>
  criarReq({ method: "GET", headers: { authorization: `Bearer ${token}` }, query, ...extra });

const corpoCredito = { cobrancaId: ID, tipo: "credit_card", valor: 100, parcelas: 3 };

// ─────────────────────────── cobrar ───────────────────────────
test("cobrar: cria a order no MP, guarda o documento e devolve só a projeção pública", async () => {
  const { handlers, mp, db } = montar();
  const res = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));

  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "created");
  assert.equal(res.corpo.cobranca.order_id, "ORD00001");
  assert.equal(res.corpo.cobranca.valor, 100);
  assert.equal("vendedor_uid" in res.corpo.cobranca, false);
  assert.equal("mp_raw" in res.corpo.cobranca, false);

  const [, body, chave] = mp.chamadas.find((c) => c[0] === "criar");
  assert.equal(chave, ID, "a chave de idempotência do MP é o id da cobrança");
  assert.equal(body.type, "point");
  assert.equal(body.external_reference, ID);
  assert.equal(body.config.point.terminal_id, TERMINAL);
  assert.equal(body.transactions.payments[0].amount, "100.00");
  assert.equal(body.config.payment_method.default_installments, 3);
  assert.equal(body.config.payment_method.installments_cost, "seller");

  const d = db.ler("cobrancas_point", ID);
  assert.equal(d.vendedor_uid, VENDEDORA.uid);
  assert.equal(d.terminal_id, TERMINAL);
  assert.equal(d.order_id, "ORD00001");
  assert.equal(d.status, "created");
  assert.ok(d.mp_raw, "guarda a resposta crua do MP pra depuração");
});

test("cobrar: repetir a mesma chamada devolve a existente sem criar outra order", async () => {
  const { handlers, mp } = montar();
  await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  const res = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.order_id, "ORD00001");
  assert.equal(mp.quantas("criar"), 1);
});

test("cobrar: se o MP falha, marca erro e a nova tentativa (mesmo id) cria a order", async () => {
  const { handlers, mp, db } = montar();
  mp.falhas.criar = Object.assign(new Error("MP fora"), { status: 502, publico: "O Mercado Pago recusou a requisição: MP fora" });

  const r1 = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  assert.equal(r1.statusCode, 502);
  assert.equal(db.ler("cobrancas_point", ID).status, "erro");

  const r2 = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.corpo.cobranca.status, "created");
  assert.equal(mp.quantas("criar"), 2);
  const chaves = mp.chamadas.filter((c) => c[0] === "criar").map((c) => c[2]);
  assert.deepEqual(chaves, [ID, ID], "mesma chave de idempotência nas duas tentativas");
});

test("cobrar: 409 do MP vira aviso de cobrança pendente na maquininha", async () => {
  const { handlers, mp } = montar();
  mp.falhas.criar = Object.assign(new Error("conflito"), { status: 502, mpStatus: 409 });
  const res = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  assert.equal(res.statusCode, 409);
  assert.match(res.corpo.erro, /cobrança pendente/i);
});

test("cobrar: débito não leva parcelas nem juros na order", async () => {
  const { handlers, mp } = montar();
  await chamar(handlers.cobrar, post("tok-vera", { cobrancaId: ID, tipo: "debit_card", valor: 50 }));
  const [, body] = mp.chamadas.find((c) => c[0] === "criar");
  assert.deepEqual(body.config.payment_method, { default_type: "debit_card" });
});

test("cobrar: valida a entrada (400) sem tocar no MP nem gravar nada", async () => {
  const { handlers, mp, db } = montar();
  const res = await chamar(handlers.cobrar, post("tok-vera", { ...corpoCredito, valor: 0 }));
  assert.equal(res.statusCode, 400);
  assert.equal(mp.chamadas.length, 0);
  assert.equal(db.ler("cobrancas_point", ID), undefined);
});

test("cobrar: sem MP_POINT_TERMINAL_ID responde 500 com mensagem clara", async () => {
  const { handlers, mp } = montar({ env: { MP_POINT_TERMINAL_ID: "" } });
  const res = await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  assert.equal(res.statusCode, 500);
  assert.match(res.corpo.erro, /MP_POINT_TERMINAL_ID/);
  assert.equal(mp.chamadas.length, 0);
});

test("cobrar: exige login, método POST e responde o preflight de CORS", async () => {
  const { handlers, mp } = montar();
  assert.equal((await chamar(handlers.cobrar, post("token-ruim", corpoCredito))).statusCode, 401);
  assert.equal((await chamar(handlers.cobrar, criarReq({ method: "POST", body: corpoCredito }))).statusCode, 401);
  assert.equal((await chamar(handlers.cobrar, get("tok-vera", {}))).statusCode, 405);
  assert.equal(mp.chamadas.length, 0);

  const pre = await chamar(
    handlers.cobrar,
    criarReq({ method: "OPTIONS", headers: { origin: "https://flora-5754a-interno.web.app" } })
  );
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "https://flora-5754a-interno.web.app");
});

test("cobrar: id já usado por outra pessoa não é reaproveitado (409)", async () => {
  const { handlers, mp } = montar();
  await chamar(handlers.cobrar, post("tok-vera", corpoCredito));
  const res = await chamar(handlers.cobrar, post("tok-caio", corpoCredito));
  assert.equal(res.statusCode, 409);
  assert.equal(mp.quantas("criar"), 1);
});

test("cobrar: o limite de requisições barra a rajada (429)", async () => {
  const { handlers: base } = montar();
  void base;
  const mp = criarMpFalso();
  const db = criarFakeDb();
  const handlers = criarHandlers({
    getDb: () => db,
    exigirStaff: async () => VENDEDORA,
    exigirAdmin: async () => ADMIN,
    mp,
    limitar: async () => {
      throw erroHttp(429, "Muitas cobranças seguidas. Espere um pouco e tente de novo.", { retryApos: 42 });
    },
    tokenDaRequisicao: () => "x",
    env: { MP_POINT_TERMINAL_ID: TERMINAL }
  }).cobrar;
  const res = await chamar(handlers, post("tok-vera", corpoCredito));
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "42");
  assert.equal(mp.chamadas.length, 0);
});

// ─────────────────────────── status ───────────────────────────
async function comCobranca(opcoes) {
  const ctx = montar(opcoes);
  await chamar(ctx.handlers.cobrar, post("tok-vera", corpoCredito));
  return ctx;
}

test("status: acompanha a order no MP (created → at_terminal)", async () => {
  const { handlers, mp, db } = await comCobranca();
  mp.avancar("ORD00001", { status: "at_terminal", status_detail: "at_terminal" });
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "at_terminal");
  assert.equal(res.corpo.cobranca.final, false);
  assert.equal(db.ler("cobrancas_point", ID).status, "at_terminal");
});

test("status: aprovada busca as taxas reais na API clássica e guarda tudo", async () => {
  const { handlers, mp, db } = await comCobranca();
  mp.pagamentos.set("998877", {
    transaction_amount: 100,
    transaction_details: { net_received_amount: 95.2, total_paid_amount: 100 },
    fee_details: [{ type: "mercadopago_fee", amount: 4.8, fee_payer: "collector" }]
  });
  mp.avancar("ORD00001", {
    status: "processed", status_detail: "accredited",
    pagamento: {
      status: "processed", paid_amount: "100.00", reference_id: 998877,
      payment_method: { id: "visa", type: "credit_card", installments: 2 }
    }
  });

  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  const c = res.corpo.cobranca;
  assert.equal(c.status, "processed");
  assert.equal(c.aprovado, true);
  assert.equal(c.final, true);
  assert.equal(c.parcelas, 2, "vale o que a maquininha reportou, não o que o PDV pediu (3x)");
  assert.equal(c.parcelas_solicitadas, 3);
  assert.equal(c.bandeira, "visa");
  assert.equal(c.valor_pago, 100);
  assert.equal(c.custo_loja, 4.8);
  assert.equal(c.liquido_mp, 95.2);
  assert.equal(c.taxa_origem, "maquininha");

  const d = db.ler("cobrancas_point", ID);
  assert.ok(d.mp_pagamento_raw, "guarda a resposta crua da API clássica");
  assert.equal(mp.quantas("pagamento"), 1);

  // Depois de final, consultar de novo não vai mais ao MP.
  const buscasAntes = mp.quantas("buscar");
  await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(mp.quantas("buscar"), buscasAntes);
});

test("status: aprovada sem id da API clássica fica sem taxa (PDV estima) e não quebra", async () => {
  const { handlers, mp } = await comCobranca();
  mp.avancar("ORD00001", {
    status: "processed",
    pagamento: { status: "processed", payment_method: { id: "master", type: "credit_card", installments: 3 } }
  });
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.corpo.cobranca.aprovado, true);
  assert.equal(res.corpo.cobranca.parcelas, 3);
  assert.equal("custo_loja" in res.corpo.cobranca, false);
  assert.equal("taxa_origem" in res.corpo.cobranca, false);
  assert.equal(mp.quantas("pagamento"), 0);
});

test("status: falha ao buscar as taxas não derruba a aprovação", async () => {
  const { handlers, mp } = await comCobranca();
  mp.falhas.pagamento = new Error("API clássica fora");
  mp.avancar("ORD00001", { status: "processed", pagamento: { status: "processed", reference_id: 555 } });
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.aprovado, true);
  assert.equal("taxa_origem" in res.corpo.cobranca, false);
});

test("status: recusada e expirada viram estados finais", async () => {
  for (const [status, detalhe] of [["failed", "rejected"], ["expired", "expired"], ["canceled", "canceled_by_terminal"]]) {
    const { handlers, mp } = await comCobranca();
    mp.avancar("ORD00001", { status, status_detail: detalhe });
    const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
    assert.equal(res.corpo.cobranca.status, status);
    assert.equal(res.corpo.cobranca.final, true);
    assert.equal(res.corpo.cobranca.aprovado, false);
    assert.equal(res.corpo.cobranca.status_detail, detalhe);
  }
});

test("status: MP fora do ar devolve o último estado conhecido com aviso (não erro)", async () => {
  const { handlers, mp, db } = await comCobranca();
  mp.falhas.buscar = new Error("timeout");
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "created");
  assert.match(res.corpo.cobranca.aviso, /Tentando de novo/);
  assert.equal("aviso" in db.ler("cobrancas_point", ID), false, "o aviso não é gravado");
});

test("status: só quem criou (ou admin) enxerga; id desconhecido é 404; id ruim é 400", async () => {
  const { handlers } = await comCobranca();
  assert.equal((await chamar(handlers.status, get("tok-caio", { cobrancaId: ID }))).statusCode, 403);
  assert.equal((await chamar(handlers.status, get("tok-dono", { cobrancaId: ID }))).statusCode, 200);
  assert.equal((await chamar(handlers.status, get("tok-vera", { cobrancaId: ID2 }))).statusCode, 404);
  assert.equal((await chamar(handlers.status, get("tok-vera", { cobrancaId: "x" }))).statusCode, 400);
  assert.equal((await chamar(handlers.status, get("token-ruim", { cobrancaId: ID }))).statusCode, 401);
});

test("status: resposta atrasada do MP não regride uma cobrança já aprovada", async () => {
  const { handlers, mp, db } = await comCobranca();
  // O documento já foi aprovado (ex.: pelo webhook)…
  const antes = db.ler("cobrancas_point", ID);
  db.collection("cobrancas_point").doc(ID).set({ ...antes, status: "at_terminal", final: false });
  // …e uma consulta de status lê do MP um estado anterior (at_terminal) enquanto
  // outra requisição grava "processed" no meio do caminho.
  const original = mp.buscarOrderPoint.bind(mp);
  mp.buscarOrderPoint = async (id) => {
    const order = await original(id);
    await db.collection("cobrancas_point").doc(ID).update({ status: "processed", final: true, aprovado: true });
    return { ...order, status: "at_terminal" };
  };
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.corpo.cobranca.status, "processed");
  assert.equal(db.ler("cobrancas_point", ID).status, "processed");
});

// ─────────────────────────── cancelar ───────────────────────────
test("cancelar: cancela no MP, relê a order e marca cancelada", async () => {
  const { handlers, mp } = await comCobranca();
  const res = await chamar(handlers.cancelar, post("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "canceled");
  assert.equal(res.corpo.cobranca.final, true);
  assert.equal(mp.quantas("cancelar"), 1);
  const [, orderId, chave] = mp.chamadas.find((c) => c[0] === "cancelar");
  assert.equal(orderId, "ORD00001");
  assert.equal(chave, `cancel-${ID}`);
});

test("cancelar: MP recusa (já está na maquininha) → 409 orientando cancelar por lá", async () => {
  const { handlers, mp } = await comCobranca();
  mp.falhas.cancelar = Object.assign(new Error("not cancelable"), { status: 502, mpStatus: 400 });
  const res = await chamar(handlers.cancelar, post("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 409);
  assert.match(res.corpo.erro, /cancele por lá/i);
});

test("cancelar: cobrança já final não vai ao MP; só o dono ou admin cancela", async () => {
  const { handlers, mp } = await comCobranca();
  mp.avancar("ORD00001", { status: "failed" });
  await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  const res = await chamar(handlers.cancelar, post("tok-vera", { cobrancaId: ID }));
  assert.equal(res.corpo.cobranca.status, "failed");
  assert.equal(mp.quantas("cancelar"), 0);

  const ctx = await comCobranca();
  assert.equal((await chamar(ctx.handlers.cancelar, post("tok-caio", { cobrancaId: ID }))).statusCode, 403);
});

test("cancelar: cobrança que nunca chegou no MP é encerrada só localmente", async () => {
  const db = criarFakeDb({
    cobrancas_point: { [ID]: { cobranca_id: ID, status: "erro", vendedor_uid: VENDEDORA.uid, valor: 10, tipo: "debit_card" } }
  });
  const { handlers, mp } = montar({ db });
  const res = await chamar(handlers.cancelar, post("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "canceled");
  assert.equal(mp.chamadas.length, 0);
});

// ─────────────────────────── estornar ───────────────────────────
async function comCobrancaAprovada() {
  const ctx = await comCobranca();
  ctx.mp.avancar("ORD00001", { status: "processed", pagamento: { status: "processed", payment_method: { id: "visa", type: "credit_card", installments: 3 } } });
  await chamar(ctx.handlers.status, get("tok-vera", { cobrancaId: ID }));
  return ctx;
}

test("estornar: só admin; vendedor leva 403", async () => {
  const { handlers, mp } = await comCobrancaAprovada();
  const res = await chamar(handlers.estornar, post("tok-vera", { cobrancaId: ID }));
  assert.equal(res.statusCode, 403);
  assert.equal(mp.quantas("estornar"), 0);
});

test("estornar: admin estorna uma cobrança aprovada e o registro guarda quem fez", async () => {
  const { handlers, mp, db } = await comCobrancaAprovada();
  const res = await chamar(handlers.estornar, post("tok-dono", { cobrancaId: ID }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.cobranca.status, "refunded");
  assert.equal(res.corpo.cobranca.estornada, true);
  assert.equal(res.corpo.cobranca.aprovado, false);
  const d = db.ler("cobrancas_point", ID);
  assert.equal(d.estornado_por_uid, ADMIN.uid);
  assert.ok(d.estornado_em);
  assert.equal(mp.chamadas.find((c) => c[0] === "estornar")[2], `refund-${ID}`);

  // Estornar de novo é idempotente: não chama o MP outra vez.
  const de_novo = await chamar(handlers.estornar, post("tok-dono", { cobrancaId: ID }));
  assert.equal(de_novo.statusCode, 200);
  assert.equal(mp.quantas("estornar"), 1);
});

test("estornar: cobrança que não foi aprovada não pode ser estornada (409)", async () => {
  const { handlers, mp } = await comCobranca();
  const res = await chamar(handlers.estornar, post("tok-dono", { cobrancaId: ID }));
  assert.equal(res.statusCode, 409);
  assert.equal(mp.quantas("estornar"), 0);
});

test("estornar: se o MP recusa (prazo de 90 dias), o documento não muda", async () => {
  const { handlers, mp, db } = await comCobrancaAprovada();
  mp.falhas.estornar = Object.assign(new Error("prazo"), { status: 502, publico: "O Mercado Pago recusou a requisição: prazo" });
  const res = await chamar(handlers.estornar, post("tok-dono", { cobrancaId: ID }));
  assert.equal(res.statusCode, 502);
  assert.equal(db.ler("cobrancas_point", ID).status, "processed");
});

// ─────────────────────────── terminais ───────────────────────────
test("terminais: admin lista e vê qual é o configurado", async () => {
  const { handlers, mp } = montar();
  mp.terminaisMp = [
    { id: TERMINAL, operating_mode: "PDV", store_id: 11, pos_id: 22, external_pos_id: "CX1" },
    { id: "NEWLAND_N950__X", operating_mode: "STANDALONE", store_id: 11, pos_id: 23 }
  ];
  const res = await chamar(handlers.terminais, get("tok-dono", {}));
  assert.equal(res.statusCode, 200);
  assert.equal(res.corpo.configurado, TERMINAL);
  assert.equal(res.corpo.terminais.length, 2);
  assert.equal(res.corpo.terminais[0].selecionado, true);
  assert.equal(res.corpo.terminais[0].modo, "PDV");
  assert.equal(res.corpo.terminais[1].selecionado, false);
});

test("terminais: troca o modo (PDV / STANDALONE) e valida a entrada", async () => {
  const { handlers, mp } = montar();
  const ok = await chamar(handlers.terminais, post("tok-dono", { terminalId: TERMINAL, modo: "STANDALONE" }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(mp.chamadas.find((c) => c[0] === "modo").slice(1), [TERMINAL, "STANDALONE"]);

  assert.equal((await chamar(handlers.terminais, post("tok-dono", { terminalId: TERMINAL, modo: "OUTRO" }))).statusCode, 400);
  assert.equal((await chamar(handlers.terminais, post("tok-dono", { modo: "PDV" }))).statusCode, 400);
});

test("terminais: vendedor não mexe (403)", async () => {
  const { handlers, mp } = montar();
  assert.equal((await chamar(handlers.terminais, get("tok-vera", {}))).statusCode, 403);
  assert.equal((await chamar(handlers.terminais, post("tok-vera", { terminalId: TERMINAL, modo: "PDV" }))).statusCode, 403);
  assert.equal(mp.chamadas.length, 0);
});

// ─────────────────────────── webhook ───────────────────────────
function assinar(segredo, { dataId, requestId, ts }) {
  const id = /[a-zA-Z]/.test(dataId) ? dataId.toLowerCase() : dataId;
  let manifest = `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;
  return `ts=${ts},v1=${crypto.createHmac("sha256", segredo).update(manifest).digest("hex")}`;
}

test("checarAssinatura: valida o HMAC do MP (id em minúsculas) e recusa adulteração", () => {
  const env = { MP_WEBHOOK_SECRET: "segredo-de-teste" };
  const dataId = "ORD00001";
  const bom = criarReq({ headers: { "x-request-id": "req-1", "x-signature": assinar(env.MP_WEBHOOK_SECRET, { dataId, requestId: "req-1", ts: "1700000000" }) } });
  assert.equal(checarAssinatura(bom, dataId, env), "ok");
  assert.equal(checarAssinatura(bom, "ORD99999", env), "nao-confere");
  assert.equal(checarAssinatura(criarReq({}), dataId, env), "sem-assinatura");
  assert.equal(checarAssinatura(criarReq({ headers: { "x-signature": "lixo" } }), dataId, env), "sem-assinatura");
  assert.equal(checarAssinatura(criarReq({ headers: { "x-signature": "ts=1,v1=zzzz" } }), dataId, env), "nao-confere");
  assert.equal(checarAssinatura(bom, dataId, {}), "sem-segredo");
});

test("webhook: notificação válida busca a order no MP e atualiza o documento", async () => {
  const segredo = "segredo-de-teste";
  const { handlers, mp, db } = await comCobranca({ env: { MP_WEBHOOK_SECRET: segredo } });
  mp.avancar("ORD00001", { status: "processed", pagamento: { status: "processed", payment_method: { id: "elo", type: "credit_card", installments: 6 } } });

  const req = criarReq({
    method: "POST",
    headers: { "x-request-id": "r1", "x-signature": assinar(segredo, { dataId: "ORD00001", requestId: "r1", ts: "1700000000" }) },
    query: { "data.id": "ORD00001" },
    body: { type: "order", action: "order.processed", data: { id: "ORD00001" } }
  });
  const res = await chamar(handlers.webhook, req);
  assert.equal(res.statusCode, 200);
  const d = db.ler("cobrancas_point", ID);
  assert.equal(d.status, "processed");
  assert.equal(d.aprovado, true);
  assert.equal(d.parcelas, 6);
  assert.equal(d.bandeira, "elo");
});

test("webhook: assinatura errada é recusada (401) e não toca em nada", async () => {
  const { handlers, mp } = await comCobranca({ env: { MP_WEBHOOK_SECRET: "segredo" } });
  const buscasAntes = mp.quantas("buscar");
  const res = await chamar(
    handlers.webhook,
    criarReq({ method: "POST", headers: { "x-signature": "ts=1,v1=00" }, query: { "data.id": "ORD00001" } })
  );
  assert.equal(res.statusCode, 401);
  assert.equal(mp.quantas("buscar"), buscasAntes);
});

test("webhook: sem segredo configurado aceita (só avisa no log) — útil nos primeiros testes", async () => {
  const { handlers, mp, db } = await comCobranca();
  mp.avancar("ORD00001", { status: "at_terminal" });
  const res = await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "ORD00001" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(db.ler("cobrancas_point", ID).status, "at_terminal");
});

test("webhook: ignora o que não é order do sistema (200, sem criar documento)", async () => {
  const { handlers, mp, db } = await comCobranca();
  const buscasAntes = mp.quantas("buscar");

  // notificação de outro tópico (id numérico de pagamento)
  const r1 = await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "123456" } }));
  assert.equal(r1.statusCode, 200);
  assert.equal(mp.quantas("buscar"), buscasAntes);

  // order de outra integração: external_reference que não é nossa
  mp.orders.set("ORDOUTRA", { id: "ORDOUTRA", external_reference: "pedido-do-site-123456789", status: "processed", transactions: { payments: [] } });
  const r2 = await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "ORDOUTRA" } }));
  assert.equal(r2.statusCode, 200);
  assert.equal(db.ler("cobrancas_point", "pedido-do-site-123456789"), undefined);

  // order nossa em formato válido mas sem documento (ex.: outro ambiente)
  mp.orders.set("ORDFANTASMA", { id: "ORDFANTASMA", external_reference: ID2, status: "processed", transactions: { payments: [] } });
  const r3 = await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "ORDFANTASMA" } }));
  assert.equal(r3.statusCode, 200);
  assert.equal(db.ler("cobrancas_point", ID2), undefined);
});

test("webhook: falha ao consultar o MP responde 500 pra o MP tentar de novo", async () => {
  const { handlers, mp } = await comCobranca();
  mp.falhas.buscar = new Error("MP fora");
  const res = await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "ORD00001" } }));
  assert.equal(res.statusCode, 500);
});

test("webhook e status juntos: aprovação do webhook não é desfeita por consulta atrasada", async () => {
  const { handlers, mp, db } = await comCobranca();
  mp.avancar("ORD00001", { status: "processed", pagamento: { status: "processed", payment_method: { id: "visa", type: "credit_card", installments: 3 } } });
  await chamar(handlers.webhook, criarReq({ method: "POST", query: { "data.id": "ORD00001" } }));
  assert.equal(db.ler("cobrancas_point", ID).status, "processed");

  // MP passa a "responder" um estado antigo (réplica atrasada): o documento não regride.
  mp.orders.get("ORD00001").status = "at_terminal";
  const res = await chamar(handlers.status, get("tok-vera", { cobrancaId: ID }));
  assert.equal(res.corpo.cobranca.status, "processed");
});
