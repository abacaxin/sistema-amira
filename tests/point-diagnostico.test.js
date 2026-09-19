const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnosticar } = require("../api/_lib/point-diagnostico");
const { criarMpFalso } = require("./helpers/fakes");

const TERMINAL = "PAX_A910__SMARTPOS123";
const ENV_OK = { MP_ACCESS_TOKEN: "APP_USR-abc", MP_POINT_TERMINAL_ID: TERMINAL, MP_WEBHOOK_SECRET: "segredo" };
const firebaseOk = async () => ({ projectId: "flora-5754a" });

const nivel = (r, id) => r.checks.find((c) => c.id === id).nivel;
const item = (r, id) => r.checks.find((c) => c.id === id);

function mpComTerminais(terminais = [{ id: TERMINAL, operating_mode: "PDV", store_id: 1, pos_id: 2, external_pos_id: "CX1" }]) {
  const mp = criarMpFalso();
  mp.terminaisMp = terminais;
  return mp;
}

test("tudo certo: nenhum erro, terminal em modo PDV marcado como selecionado", async () => {
  const r = await diagnosticar({ env: ENV_OK, mp: mpComTerminais(), checarFirebase: firebaseOk });
  assert.equal(r.ok, true);
  for (const id of ["token_mp", "firebase", "terminais", "terminal_configurado", "webhook", "cors"]) {
    assert.equal(nivel(r, id), "ok", id);
  }
  assert.match(item(r, "token_mp").detalhe, /LOJA_AMIRA/);
  assert.equal(r.configurado, TERMINAL);
  assert.equal(r.terminais[0].selecionado, true);
  assert.equal(r.terminais[0].modo, "PDV");
});

test("sem token: erro com o passo a passo e sem chamar o Mercado Pago", async () => {
  const mp = mpComTerminais();
  const r = await diagnosticar({ env: { ...ENV_OK, MP_ACCESS_TOKEN: "" }, mp, checarFirebase: firebaseOk });
  assert.equal(r.ok, false);
  assert.equal(nivel(r, "token_mp"), "erro");
  assert.match(item(r, "token_mp").acao, /Credenciais de produção/);
  assert.equal(mp.chamadas.length, 0, "sem token não consulta terminais nem o usuário");
  assert.equal(nivel(r, "terminais"), "aviso");
});

test("token recusado pelo MP: erro com a mensagem do MP e terminais não consultados", async () => {
  const mp = mpComTerminais();
  mp.falhas.usuario = Object.assign(new Error("x"), { status: 502, publico: "O Mercado Pago recusou a requisição: invalid access token" });
  const r = await diagnosticar({ env: ENV_OK, mp, checarFirebase: firebaseOk });
  assert.equal(nivel(r, "token_mp"), "erro");
  assert.match(item(r, "token_mp").detalhe, /invalid access token/);
  assert.equal(mp.quantas("terminais"), 0);
  assert.equal(nivel(r, "terminais"), "aviso");
});

test("credenciais de TESTE viram aviso (a maquininha real exige produção)", async () => {
  const r = await diagnosticar({ env: { ...ENV_OK, MP_ACCESS_TOKEN: "TEST-123" }, mp: mpComTerminais(), checarFirebase: firebaseOk });
  assert.equal(nivel(r, "token_mp"), "aviso");
  assert.match(item(r, "token_mp").detalhe, /TESTE/);
  assert.equal(r.ok, true, "aviso não impede");
});

test("Firebase: falha vira erro com a orientação; projeto diferente vira aviso", async () => {
  const falha = await diagnosticar({
    env: ENV_OK,
    mp: mpComTerminais(),
    checarFirebase: async () => { throw new Error("FIREBASE_SERVICE_ACCOUNT não configurada"); }
  });
  assert.equal(nivel(falha, "firebase"), "erro");
  assert.match(item(falha, "firebase").acao, /serviceAccount\.json/);
  assert.equal(falha.ok, false);

  const outro = await diagnosticar({ env: ENV_OK, mp: mpComTerminais(), checarFirebase: async () => ({ projectId: "outro-projeto" }) });
  assert.equal(nivel(outro, "firebase"), "aviso");
  assert.match(item(outro, "firebase").detalhe, /outro-projeto/);
});

test("conta sem nenhum terminal: erro explicando como vincular", async () => {
  const r = await diagnosticar({ env: ENV_OK, mp: mpComTerminais([]), checarFirebase: firebaseOk });
  assert.equal(nivel(r, "terminais"), "erro");
  assert.match(item(r, "terminais").acao, /app/);
  assert.equal(nivel(r, "terminal_configurado"), "aviso", "não dá pra conferir contra uma lista vazia");
});

test("MP_POINT_TERMINAL_ID vazio: com 1 terminal sugere o id; com vários manda escolher", async () => {
  const um = await diagnosticar({ env: { ...ENV_OK, MP_POINT_TERMINAL_ID: "" }, mp: mpComTerminais(), checarFirebase: firebaseOk });
  assert.equal(nivel(um, "terminal_configurado"), "erro");
  assert.match(item(um, "terminal_configurado").acao, new RegExp(TERMINAL));
  assert.match(item(um, "terminal_configurado").acao, /--gravar/);
  assert.equal(um.configurado, null);

  const varios = await diagnosticar({
    env: { ...ENV_OK, MP_POINT_TERMINAL_ID: "" },
    mp: mpComTerminais([{ id: "A__1", operating_mode: "PDV" }, { id: "B__2", operating_mode: "STANDALONE" }]),
    checarFirebase: firebaseOk
  });
  assert.match(item(varios, "terminal_configurado").acao, /lista acima/);
});

test("MP_POINT_TERMINAL_ID que não existe na conta: erro listando os ids válidos", async () => {
  const r = await diagnosticar({ env: { ...ENV_OK, MP_POINT_TERMINAL_ID: "ERRADO__0" }, mp: mpComTerminais(), checarFirebase: firebaseOk });
  assert.equal(nivel(r, "terminal_configurado"), "erro");
  assert.match(item(r, "terminal_configurado").acao, new RegExp(TERMINAL));
});

test("terminal em modo autônomo: erro dizendo como colocar em PDV", async () => {
  const mp = mpComTerminais([{ id: TERMINAL, operating_mode: "STANDALONE" }]);
  const r = await diagnosticar({ env: ENV_OK, mp, checarFirebase: firebaseOk });
  assert.equal(nivel(r, "terminal_configurado"), "erro");
  assert.match(item(r, "terminal_configurado").detalhe, /STANDALONE/);
  assert.match(item(r, "terminal_configurado").acao, /modo PDV/);
  assert.equal(r.ok, false);
});

test("falha ao listar terminais: erro, e o resto do diagnóstico continua", async () => {
  const mp = mpComTerminais();
  mp.falhas.terminais = Object.assign(new Error("x"), { status: 502, publico: "O Mercado Pago recusou a requisição: forbidden" });
  const r = await diagnosticar({ env: ENV_OK, mp, checarFirebase: firebaseOk });
  assert.equal(nivel(r, "terminais"), "erro");
  assert.equal(nivel(r, "firebase"), "ok");
  assert.equal(nivel(r, "webhook"), "ok");
});

test("sem MP_WEBHOOK_SECRET é só aviso; CORS lista as origens efetivas", async () => {
  const r = await diagnosticar({
    env: { ...ENV_OK, MP_WEBHOOK_SECRET: "", CORS_ORIGINS: "https://a.example" },
    mp: mpComTerminais(),
    checarFirebase: firebaseOk
  });
  assert.equal(nivel(r, "webhook"), "aviso");
  assert.equal(r.ok, true);
  assert.equal(item(r, "cors").detalhe, "https://a.example");
});

test("o resultado nunca carrega valor de segredo", async () => {
  const r = await diagnosticar({ env: { ...ENV_OK, MP_WEBHOOK_SECRET: "SEGREDO-ULTRA" }, mp: mpComTerminais(), checarFirebase: firebaseOk });
  const texto = JSON.stringify(r);
  assert.equal(texto.includes("SEGREDO-ULTRA"), false);
  assert.equal(texto.includes("APP_USR-abc"), false);
});
