import test from "node:test";
import assert from "node:assert/strict";

import {
  criarClientePoint,
  iniciarCobranca,
  quemPagaJuros,
  resultadoDe,
  textoStatus,
  aguardarCobranca,
  pagamentoDaMaquininha,
  marcarAprovada,
  novoCobrancaId,
  TIPO_POINT
} from "../public/assets/js/point.js";

// ── fetch falso ──
function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, ...opcoes });
    const r = fila.length > 1 ? fila.shift() : fila[0];
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, json: async () => (r.corpo === undefined ? Promise.reject(new Error("sem json")) : r.corpo) };
  };
  fn.chamadas = chamadas;
  return fn;
}
const cliente = (fetchImpl, apiBase = "https://api.exemplo.app") =>
  criarClientePoint({ apiBase, obterToken: async () => "TOKEN-DE-TESTE", fetchImpl });

test("novoCobrancaId respeita o formato aceito pelo MP (external_reference)", () => {
  const id = novoCobrancaId();
  assert.match(id, /^pdv-[A-Za-z0-9_-]{8,}$/);
  assert.ok(id.length <= 64);
  assert.notEqual(id, novoCobrancaId());
});

test("cliente: monta URL com apiBase, manda token e corpo JSON", async () => {
  const f = fetchFalso([{ status: 200, corpo: { cobranca: { status: "created" } } }]);
  const c = cliente(f, "https://api.exemplo.app///");
  const r = await c.cobrar({ cobrancaId: "pdv-1", tipo: "credit_card", valor: 10 });
  assert.equal(r.cobranca.status, "created");
  const ch = f.chamadas[0];
  assert.equal(ch.url, "https://api.exemplo.app/api/point/cobrar");
  assert.equal(ch.method, "POST");
  assert.equal(ch.headers.Authorization, "Bearer TOKEN-DE-TESTE");
  assert.equal(ch.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(ch.body), { cobrancaId: "pdv-1", tipo: "credit_card", valor: 10 });
});

test("cliente: apiBase vazio usa a mesma origem; status escapa o id; GET não manda corpo", async () => {
  const f = fetchFalso([{ status: 200, corpo: {} }]);
  await cliente(f, "").status("pdv a&b");
  assert.equal(f.chamadas[0].url, "/api/point/status?cobrancaId=pdv%20a%26b");
  assert.equal(f.chamadas[0].method, "GET");
  assert.equal(f.chamadas[0].body, undefined);
  assert.equal("Content-Type" in f.chamadas[0].headers, false);
});

test("cliente: cancelar, estornar e terminais chamam as rotas certas", async () => {
  const f = fetchFalso([{ status: 200, corpo: {} }]);
  const c = cliente(f);
  await c.cancelar("pdv-9");
  await c.estornar("pdv-9");
  await c.terminais();
  await c.definirModo("PAX__1", "STANDALONE");
  assert.deepEqual(f.chamadas.map((x) => [x.method, x.url.replace("https://api.exemplo.app", "")]), [
    ["POST", "/api/point/cancelar"],
    ["POST", "/api/point/estornar"],
    ["GET", "/api/point/terminais"],
    ["POST", "/api/point/terminais"]
  ]);
  assert.deepEqual(JSON.parse(f.chamadas[3].body), { terminalId: "PAX__1", modo: "STANDALONE" });
});

test("cliente: erro da NOSSA API é definitivo e carrega mensagem e status", async () => {
  const f = fetchFalso([{ status: 409, corpo: { erro: "A maquininha já tem uma cobrança pendente." } }]);
  await assert.rejects(
    () => cliente(f).cobrar({}),
    (e) => e.status === 409 && e.definitivo === true && /pendente/.test(e.message)
  );
});

test("cliente: erro de rede e de gateway (sem JSON nosso) NÃO são definitivos", async () => {
  await assert.rejects(
    () => cliente(fetchFalso([new TypeError("Failed to fetch")])).cobrar({}),
    (e) => e.rede === true && e.definitivo !== true && /Sem conexão/.test(e.message)
  );
  await assert.rejects(
    () => cliente(fetchFalso([{ status: 504 }])).cobrar({}),
    (e) => e.status === 504 && e.definitivo === false
  );
});

test("iniciarCobranca: criada / falhou (definitivo) / incerta (rede ou gateway)", async () => {
  const ok = await iniciarCobranca(cliente(fetchFalso([{ status: 200, corpo: { cobranca: { status: "created" } } }])), {});
  assert.equal(ok.estado, "criada");
  assert.equal(ok.cobranca.status, "created");

  const falhou = await iniciarCobranca(cliente(fetchFalso([{ status: 400, corpo: { erro: "Valor inválido." } }])), {});
  assert.equal(falhou.estado, "falhou");

  const rede = await iniciarCobranca(cliente(fetchFalso([new TypeError("x")])), {});
  assert.equal(rede.estado, "incerta");
  const gateway = await iniciarCobranca(cliente(fetchFalso([{ status: 504 }])), {});
  assert.equal(gateway.estado, "incerta");
});

test("quemPagaJuros segue a tabela: cliente com juros > 0 e parcelado → buyer; senão seller", () => {
  assert.equal(quemPagaJuros({ tipo: "credit_card", parcelas: 3, taxas: { cliente: 5, loja: 2 } }), "buyer");
  assert.equal(quemPagaJuros({ tipo: "credit_card", parcelas: 3, taxas: { cliente: 0, loja: 2 } }), "seller");
  assert.equal(quemPagaJuros({ tipo: "credit_card", parcelas: 1, taxas: { cliente: 5, loja: 2 } }), "seller");
  assert.equal(quemPagaJuros({ tipo: "debit_card", parcelas: 1, taxas: { cliente: 5 } }), "seller");
  assert.equal(quemPagaJuros({ tipo: "credit_card", parcelas: 6, taxas: undefined }), "seller");
});

test("resultadoDe / textoStatus", () => {
  assert.equal(resultadoDe({ status: "processed" }), "aprovada");
  assert.equal(resultadoDe({ status: "failed" }), "recusada");
  assert.equal(resultadoDe({ status: "canceled" }), "cancelada");
  assert.equal(resultadoDe({ status: "expired" }), "expirada");
  assert.equal(resultadoDe({ status: "refunded" }), "estornada");
  assert.equal(resultadoDe({ status: "at_terminal" }), null);
  assert.equal(resultadoDe(null), null);
  assert.match(textoStatus({ status: "at_terminal" }), /passar ou aproximar o cartão/);
  assert.match(textoStatus({ status: "created" }), /Enviando/);
  assert.match(textoStatus({ status: "sem_conexao" }), /Sem conexão/);
});

// ── aguardarCobranca ──
function clienteDeStatus(passos) {
  const fila = [...passos];
  const chamadas = [];
  return {
    chamadas,
    status: async (id) => {
      chamadas.push(id);
      const p = fila.length > 1 ? fila.shift() : fila[0];
      if (p instanceof Error) throw p;
      return { cobranca: p };
    }
  };
}
const semEspera = { dormir: async () => {} };

test("aguardar: acompanha created → at_terminal → processed e devolve aprovada", async () => {
  const c = clienteDeStatus([{ status: "created" }, { status: "at_terminal" }, { status: "processed", parcelas: 3 }]);
  const vistos = [];
  const r = await aguardarCobranca(c, "pdv-1", { ...semEspera, onEstado: (x) => vistos.push(x.status) });
  assert.equal(r.resultado, "aprovada");
  assert.equal(r.cobranca.parcelas, 3);
  assert.deepEqual(vistos, ["created", "at_terminal", "processed"]);
  assert.equal(c.chamadas.length, 3);
});

test("aguardar: recusada, cancelada e expirada terminam a espera", async () => {
  for (const [status, esperado] of [["failed", "recusada"], ["canceled", "cancelada"], ["expired", "expirada"]]) {
    const r = await aguardarCobranca(clienteDeStatus([{ status: "at_terminal" }, { status }]), "pdv-1", semEspera);
    assert.equal(r.resultado, esperado);
  }
});

test("aguardar: 404 = a cobrança nunca foi criada (inexistente)", async () => {
  const c = clienteDeStatus([Object.assign(new Error("Cobrança não encontrada."), { status: 404 })]);
  assert.deepEqual(await aguardarCobranca(c, "pdv-1", semEspera), { resultado: "inexistente" });
});

test("aguardar: 401/403 interrompem com erro (insistir não adianta)", async () => {
  for (const status of [401, 403]) {
    const c = clienteDeStatus([Object.assign(new Error("negado"), { status })]);
    await assert.rejects(() => aguardarCobranca(c, "pdv-1", semEspera), (e) => e.status === status);
  }
});

test("aguardar: queda de rede não interrompe — avisa e continua até aprovar", async () => {
  const c = clienteDeStatus([
    { status: "at_terminal" },
    Object.assign(new Error("Sem conexão"), { rede: true }),
    Object.assign(new Error("Sem conexão"), { rede: true }),
    { status: "processed" }
  ]);
  const vistos = [];
  const r = await aguardarCobranca(c, "pdv-1", { ...semEspera, onEstado: (x) => vistos.push(x.status) });
  assert.equal(r.resultado, "aprovada");
  assert.deepEqual(vistos, ["at_terminal", "sem_conexao", "sem_conexao", "processed"]);
});

test("aguardar: parar() (modal fechado) devolve pendente sem cancelar nada", async () => {
  const c = clienteDeStatus([{ status: "at_terminal" }]);
  let voltas = 0;
  const r = await aguardarCobranca(c, "pdv-1", { ...semEspera, parar: () => ++voltas > 3 });
  assert.equal(r.resultado, "pendente");
});

test("aguardar: parar() já verdadeiro nem consulta o servidor", async () => {
  const c = clienteDeStatus([{ status: "at_terminal" }]);
  const r = await aguardarCobranca(c, "pdv-1", { ...semEspera, parar: () => true });
  assert.equal(r.resultado, "pendente");
  assert.equal(c.chamadas.length, 0);
});

test("aguardar: estourou o tempo → pendente (a cobrança pode seguir viva)", async () => {
  const c = clienteDeStatus([{ status: "at_terminal" }]);
  let t = 0;
  const r = await aguardarCobranca(c, "pdv-1", { dormir: async () => { t += 300000; }, agora: () => t, timeoutMs: 600000, intervaloMs: 1000 });
  assert.equal(r.resultado, "pendente");
  assert.equal(r.cobranca.status, "at_terminal");
});

test("aguardar: recua o intervalo quando o servidor está instável", async () => {
  const c = clienteDeStatus([
    Object.assign(new Error("x"), { rede: true }),
    Object.assign(new Error("x"), { rede: true }),
    { status: "processed" }
  ]);
  const esperas = [];
  await aguardarCobranca(c, "pdv-1", { intervaloMs: 1000, dormir: async (ms) => esperas.push(ms) });
  // 1ª falha → 2000ms, 2ª falha → 3000ms (em fatias de 250ms)
  const soma = (a) => a.reduce((s, n) => s + n, 0);
  assert.equal(soma(esperas.slice(0, 8)), 2000);
  assert.equal(soma(esperas.slice(8)), 3000);
});

// ── pagamentoDaMaquininha ──
const estimativa = { valorComJuros: 105, custoLoja: 2 };
const semUndefined = (o) => assert.deepEqual(JSON.parse(JSON.stringify(o)), o, "sem valores undefined (o Firestore recusa)");

test("pagamentoDaMaquininha: usa os números reais da maquininha", () => {
  const p = {
    forma: "credito", valor: 100, parcelas: 3,
    point: { cobrancaId: "pdv-1", status: "processed", order_id: "ORD1", payment_id: "PAY1", bandeira: "visa", parcelas: 3, valor_pago: 114.31, custo_loja: 5.31 }
  };
  const r = pagamentoDaMaquininha(p, estimativa, true);
  assert.equal(r.forma, "credito");
  assert.equal(r.valor, 100, "valor continua sendo o de tabela");
  assert.equal(r.parcelas, 3);
  assert.equal(r.valor_parcela, 38.1);
  assert.equal(r.juros_pct, 14.31);
  assert.equal(r.pct_loja, 5.31);
  assert.equal(r.valor_com_juros, 114.31);
  assert.equal(r.custo_loja, 5.31);
  assert.equal(r.valor_liquido, 94.69, "líquido = valor original − custo (não o valor com juros)");
  assert.equal(r.origem_taxa, "maquininha");
  assert.deepEqual(r.point, { cobranca_id: "pdv-1", order_id: "ORD1", payment_id: "PAY1", bandeira: "visa", tipo: "credit_card", status: "processed" });
  semUndefined(r);
});

test("pagamentoDaMaquininha: sem taxa real cai na estimativa e marca como estimada", () => {
  const p = { forma: "credito", valor: 100, parcelas: 3, point: { cobrancaId: "pdv-2", status: "processed", parcelas: 3 } };
  const r = pagamentoDaMaquininha(p, estimativa, true);
  assert.equal(r.custo_loja, 2);
  assert.equal(r.valor_com_juros, 105);
  assert.equal(r.valor_liquido, 98);
  assert.equal(r.origem_taxa, "estimada");
  semUndefined(r);
});

test("pagamentoDaMaquininha: débito não parcela e não tem parcelas/valor_parcela", () => {
  const p = { forma: "debito", valor: 50, parcelas: 1, point: { cobrancaId: "pdv-3", status: "processed", valor_pago: 50, custo_loja: 0.75 } };
  const r = pagamentoDaMaquininha(p, { valorComJuros: 50, custoLoja: 0 }, false);
  assert.equal("parcelas" in r, false);
  assert.equal("valor_parcela" in r, false);
  assert.equal(r.custo_loja, 0.75);
  assert.equal(r.valor_liquido, 49.25);
  assert.equal(r.point.tipo, "debit_card");
  semUndefined(r);
});

test("pagamentoDaMaquininha: 1x à vista no crédito não grava parcelas; parcelas vêm da maquininha se ela trocou", () => {
  const avista = pagamentoDaMaquininha({ forma: "credito", valor: 80, parcelas: 3, point: { cobrancaId: "pdv-4", status: "processed", parcelas: 1, valor_pago: 80, custo_loja: 2 } }, estimativa, true);
  assert.equal("parcelas" in avista, false);
  const trocou = pagamentoDaMaquininha({ forma: "credito", valor: 100, parcelas: 3, point: { cobrancaId: "pdv-5", status: "processed", parcelas: 6, valor_pago: 100, custo_loja: 4 } }, estimativa, true);
  assert.equal(trocou.parcelas, 6);
  assert.equal(trocou.valor_parcela, 16.67);
});

test("pagamentoDaMaquininha: juros_pct nunca fica negativo e valor 0 não divide por zero", () => {
  const r = pagamentoDaMaquininha({ forma: "debito", valor: 100, point: { cobrancaId: "pdv-6", status: "processed", valor_pago: 99, custo_loja: 1 } }, estimativa, false);
  assert.equal(r.juros_pct, 0);
  const zero = pagamentoDaMaquininha({ forma: "debito", valor: 0, point: { cobrancaId: "pdv-7", status: "processed", valor_pago: 0, custo_loja: 0 } }, estimativa, false);
  assert.equal(zero.pct_loja, 0);
  assert.equal(zero.juros_pct, 0);
});

test("marcarAprovada guarda o que a cobrança informou e ajusta as parcelas da linha", () => {
  const pg = { forma: "credito", valor: 100, parcelas: 3 };
  marcarAprovada(pg, {
    cobranca_id: "pdv-1", order_id: "ORD1", payment_id: "PAY1", bandeira: "elo", parcelas: 2, valor_pago: 100, custo_loja: 4.1, liquido_mp: 95.9
  });
  assert.equal(pg.parcelas, 2);
  assert.deepEqual(pg.point, {
    cobrancaId: "pdv-1", status: "processed", order_id: "ORD1", payment_id: "PAY1", bandeira: "elo",
    parcelas: 2, valor_pago: 100, custo_loja: 4.1, liquido_mp: 95.9
  });
});

test("TIPO_POINT: só crédito e débito passam pela maquininha", () => {
  assert.deepEqual(TIPO_POINT, { credito: "credit_card", debito: "debit_card" });
});
