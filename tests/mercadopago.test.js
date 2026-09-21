const test = require("node:test");
const assert = require("node:assert/strict");

// Cada arquivo de teste roda em processo próprio: trocar o fetch global aqui é seguro.
const chamadas = [];
let proximaResposta = { ok: true, status: 200, corpo: {} };
globalThis.fetch = async (url, opcoes) => {
  chamadas.push({ url, ...opcoes });
  const r = proximaResposta;
  return { ok: r.ok, status: r.status, json: async () => r.corpo };
};
const responder = (corpo, { ok = true, status = 200 } = {}) => {
  proximaResposta = { ok, status, corpo };
  chamadas.length = 0;
};

process.env.MP_ACCESS_TOKEN = "APP_USR-token-de-teste";
const mp = require("../api/_lib/mercadopago");

test("criarOrderPoint: POST /v1/orders com token, chave de idempotência e corpo JSON", async () => {
  responder({ id: "ORD1" });
  const r = await mp.criarOrderPoint({ type: "point" }, "pdv-abc-123456");
  assert.deepEqual(r, { id: "ORD1" });
  const c = chamadas[0];
  assert.equal(c.url, "https://api.mercadopago.com/v1/orders");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.Authorization, "Bearer APP_USR-token-de-teste");
  assert.equal(c.headers["X-Idempotency-Key"], "pdv-abc-123456");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(c.body), { type: "point" });
});

test("buscarOrderPoint: GET com o id escapado na URL", async () => {
  responder({ id: "ORD/1" });
  await mp.buscarOrderPoint("ORD/1?x=y");
  assert.equal(chamadas[0].url, "https://api.mercadopago.com/v1/orders/ORD%2F1%3Fx%3Dy");
  assert.equal(chamadas[0].method, "GET");
  assert.equal(chamadas[0].body, undefined);
  assert.equal("X-Idempotency-Key" in chamadas[0].headers, false);
});

test("cancelarOrderPoint: pede o cancelamento mesmo na maquininha (header) e manda idempotência", async () => {
  responder({ status: "canceled" });
  await mp.cancelarOrderPoint("ORD1", "cancel-1");
  const c = chamadas[0];
  assert.equal(c.url, "https://api.mercadopago.com/v1/orders/ORD1/cancel");
  assert.equal(c.method, "POST");
  assert.equal(c.headers["x-allow-cancelable-status"], "at_terminal");
  assert.equal(c.headers["X-Idempotency-Key"], "cancel-1");
});

test("estornarOrderPoint: POST /refund sem corpo", async () => {
  responder({ status: "refunded" });
  await mp.estornarOrderPoint("ORD1", "refund-1");
  const c = chamadas[0];
  assert.equal(c.url, "https://api.mercadopago.com/v1/orders/ORD1/refund");
  assert.equal(c.method, "POST");
  assert.equal(c.body, undefined);
  assert.equal(c.headers["X-Idempotency-Key"], "refund-1");
});

test("terminais: lista com paginação e troca de modo via PATCH /terminals/v1/setup", async () => {
  responder({ data: { terminals: [] } });
  await mp.listarTerminais();
  assert.equal(chamadas[0].url, "https://api.mercadopago.com/terminals/v1/list?limit=50&offset=0");

  responder({});
  await mp.definirModoTerminal("PAX_A910__X", "PDV");
  const c = chamadas[0];
  assert.equal(c.url, "https://api.mercadopago.com/terminals/v1/setup");
  assert.equal(c.method, "PATCH");
  assert.deepEqual(JSON.parse(c.body), { terminals: [{ id: "PAX_A910__X", operating_mode: "PDV" }] });
});

test("buscarPagamento: API clássica /v1/payments/{id}", async () => {
  responder({ id: 1 });
  await mp.buscarPagamento(123456789);
  assert.equal(chamadas[0].url, "https://api.mercadopago.com/v1/payments/123456789");
});

test("usuarioAtual: GET /users/me com o token (prova de qual conta é o access token)", async () => {
  responder({ id: 998877, nickname: "LOJA_AMIRA", site_id: "MLB" });
  const eu = await mp.usuarioAtual();
  assert.equal(eu.nickname, "LOJA_AMIRA");
  assert.equal(chamadas[0].url, "https://api.mercadopago.com/users/me");
  assert.equal(chamadas[0].method, "GET");
  assert.equal(chamadas[0].headers.Authorization, "Bearer APP_USR-token-de-teste");
  assert.equal(chamadas[0].body, undefined);
});

test("erro do MP vira 502 com a mensagem do MP (publico) e guarda o HTTP original", async () => {
  responder({ errors: [{ code: "invalid_terminal", message: "Terminal não está em modo PDV" }] }, { ok: false, status: 400 });
  await assert.rejects(
    () => mp.criarOrderPoint({}, "k"),
    (e) => {
      assert.equal(e.status, 502);
      assert.equal(e.mpStatus, 400);
      assert.match(e.publico, /Terminal não está em modo PDV/);
      assert.match(e.message, /HTTP 400/);
      assert.deepEqual(e.detalhe.errors[0].code, "invalid_terminal");
      return true;
    }
  );
});

test("erro sem corpo JSON ainda vira erro legível; 409 preserva o mpStatus", async () => {
  proximaResposta = { ok: false, status: 409, corpo: undefined };
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => { throw new Error("sem json"); } });
  await assert.rejects(
    () => mp.criarOrderPoint({}, "k"),
    (e) => e.mpStatus === 409 && e.status === 502 && /HTTP 409/.test(e.publico)
  );
});

test("sem MP_ACCESS_TOKEN falha antes de chamar a rede", async () => {
  let chamou = false;
  globalThis.fetch = async () => { chamou = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const guardado = process.env.MP_ACCESS_TOKEN;
  delete process.env.MP_ACCESS_TOKEN;
  try {
    await assert.rejects(() => mp.buscarOrderPoint("ORD1"), /MP_ACCESS_TOKEN/);
    assert.equal(chamou, false);
  } finally {
    process.env.MP_ACCESS_TOKEN = guardado;
  }
});
