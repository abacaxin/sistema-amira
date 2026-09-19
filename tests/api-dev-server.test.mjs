import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { criarServidor, linhasDoBanner, ROTAS_REAIS } from "../scripts/api-dev.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Sobe o servidor numa porta livre, roda o teste e derruba.
async function comServidor(rotas, fn, opcoes) {
  const servidor = criarServidor(rotas, opcoes);
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  const { port } = servidor.address();
  try {
    return await fn({ port, servidor });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
}

// http.request em vez de fetch: dá pra mandar Origin/OPTIONS sem restrição de navegador.
function pedir(port, { metodo = "GET", caminho = "/", headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: metodo, path: caminho, headers }, (res) => {
      const partes = [];
      res.on("data", (p) => partes.push(p));
      res.on("end", () => {
        const texto = Buffer.concat(partes).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(texto);
        } catch {
          /* corpo vazio ou não-JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, texto, json });
      });
    });
    req.on("error", reject);
    if (corpo !== undefined) req.write(corpo);
    req.end();
  });
}

test("servidor: escuta só em 127.0.0.1 (nunca exposto à rede)", async () => {
  await comServidor({}, async ({ servidor }) => {
    assert.equal(servidor.address().address, "127.0.0.1");
  });
});

test("servidor: /api/health responde e rota desconhecida é 404 em JSON", async () => {
  await comServidor({}, async ({ port }) => {
    const h = await pedir(port, { caminho: "/api/health" });
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);

    const n = await pedir(port, { caminho: "/api/nao-existe" });
    assert.equal(n.status, 404);
    assert.match(n.json.erro, /não encontrada/i);
    assert.match(n.headers["content-type"], /application\/json/);

    // nomes herdados de Object.prototype não viram rota
    assert.equal((await pedir(port, { caminho: "/constructor" })).status, 404);
    assert.equal((await pedir(port, { caminho: "/__proto__" })).status, 404);
  });
});

test("servidor: entrega ao handler req.query, req.body (JSON), req.method e headers, como a Vercel", async () => {
  let visto;
  const rotas = {
    "/api/eco": (req, res) => {
      visto = { query: req.query, body: req.body, method: req.method, auth: req.headers.authorization };
      return res.status(201).json({ ok: true });
    }
  };
  await comServidor(rotas, async ({ port }) => {
    const r = await pedir(port, {
      metodo: "POST",
      caminho: "/api/eco/?cobrancaId=abc123&data.id=ORD9",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      corpo: JSON.stringify({ valor: 12.5, tipo: "debit_card" })
    });
    assert.equal(r.status, 201, "res.status(201).json(...) e barra final na rota");
    assert.match(r.headers["content-type"], /application\/json; charset=utf-8/);
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(visto.query, { cobrancaId: "abc123", "data.id": "ORD9" });
    assert.deepEqual(visto.body, { valor: 12.5, tipo: "debit_card" });
    assert.equal(visto.method, "POST");
    assert.equal(visto.auth, "Bearer tok");
  });
});

test("servidor: GET sem corpo entrega body undefined; corpo que não é JSON chega como texto", async () => {
  const vistos = [];
  const rotas = {
    "/api/x": (req, res) => {
      vistos.push(req.body);
      return res.status(200).json({});
    }
  };
  await comServidor(rotas, async ({ port }) => {
    await pedir(port, { caminho: "/api/x" });
    await pedir(port, { metodo: "POST", caminho: "/api/x", headers: { "content-type": "text/plain" }, corpo: "olá" });
    assert.deepEqual(vistos, [undefined, "olá"]);
  });
});

test("servidor: JSON inválido → 400 e o handler nem é chamado", async () => {
  let chamou = false;
  const rotas = { "/api/x": (req, res) => ((chamou = true), res.status(200).json({})) };
  await comServidor(rotas, async ({ port }) => {
    const r = await pedir(port, { metodo: "POST", caminho: "/api/x", headers: { "content-type": "application/json" }, corpo: "{quebrado" });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /JSON válido/);
    assert.equal(chamou, false);
  });
});

test("servidor: corpo grande demais → 413 e o servidor continua de pé", async () => {
  let chamadas = 0;
  const rotas = { "/api/x": (req, res) => ((chamadas += 1), res.status(200).json({})) };
  await comServidor(rotas, async ({ port }) => {
    const grande = JSON.stringify({ lixo: "x".repeat(1024 * 1024 + 10) });
    const r = await pedir(port, { metodo: "POST", caminho: "/api/x", headers: { "content-type": "application/json" }, corpo: grande });
    assert.equal(r.status, 413);
    assert.equal(chamadas, 0);
    assert.equal((await pedir(port, { caminho: "/api/x" })).status, 200, "segue atendendo");
  });
});

test("servidor: handler que estoura vira 500 genérico (sem vazar a mensagem) e o servidor segue de pé", async () => {
  const rotas = {
    "/api/bug": () => {
      throw new Error("segredo-interno-XYZ");
    },
    "/api/ok": (req, res) => res.status(200).json({ ok: true })
  };
  const originalErro = console.error;
  console.error = () => {}; // o servidor loga o erro; aqui não interessa poluir a saída do teste
  try {
    await comServidor(rotas, async ({ port }) => {
      const r = await pedir(port, { caminho: "/api/bug" });
      assert.equal(r.status, 500);
      assert.equal(r.texto.includes("segredo-interno-XYZ"), false);
      assert.equal((await pedir(port, { caminho: "/api/ok" })).status, 200);
    });
  } finally {
    console.error = originalErro;
  }
});

test("servidor: handler que esquece de responder não deixa a requisição pendurada", async () => {
  const rotas = { "/api/mudo": async () => {} };
  await comServidor(rotas, async ({ port }) => {
    const r = await pedir(port, { caminho: "/api/mudo" });
    assert.equal(r.status, 200);
  });
});

test("servidor: registra só método, rota e status (nada de corpo nem token)", async () => {
  const linhas = [];
  const rotas = { "/api/x": (req, res) => res.status(200).json({ segredo: "resposta-secreta" }) };
  await comServidor(
    rotas,
    async ({ port }) => {
      await pedir(port, {
        metodo: "POST",
        caminho: "/api/x?token=na-query",
        headers: { authorization: "Bearer TOKEN-SECRETO", "content-type": "application/json" },
        corpo: JSON.stringify({ senha: "corpo-secreto" })
      });
      await new Promise((ok) => setTimeout(ok, 20)); // o log sai no evento "finish"
    },
    { log: (l) => linhas.push(l) }
  );
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /^POST \/api\/x -> 200 \(\d+ms\)$/);
  assert.equal(/TOKEN-SECRETO|corpo-secreto|resposta-secreta|na-query/.test(linhas.join()), false);
});

// ── Rotas reais ──────────────────────────────────────────────────────────
const exigir = createRequire(import.meta.url);

test("ROTAS_REAIS: todas apontam pra arquivos que existem e exportam um handler", () => {
  const rotas = Object.entries(ROTAS_REAIS);
  assert.ok(rotas.length >= 7);
  for (const [rota, arquivo] of rotas) {
    assert.ok(rota.startsWith("/api/"), rota);
    assert.ok(fs.existsSync(path.join(RAIZ, arquivo)), `${arquivo} não existe`);
    assert.equal(typeof exigir(path.join(RAIZ, arquivo)), "function", `${arquivo} não exporta função`);
  }
});

test("rotas reais pelo servidor: sem login é 401 em JSON (nem precisa de credencial) e o preflight de CORS passa", async () => {
  const rotas = Object.fromEntries(Object.entries(ROTAS_REAIS).map(([r, a]) => [r, exigir(path.join(RAIZ, a))]));
  await comServidor(rotas, async ({ port }) => {
    for (const caminho of ["/api/point/diagnostico", "/api/point/terminais", "/api/point/status?cobrancaId=pdv-12345678"]) {
      const r = await pedir(port, { caminho });
      assert.equal(r.status, 401, caminho);
      assert.match(r.json.erro, /Entre no sistema/);
    }
    const cobrar = await pedir(port, {
      metodo: "POST",
      caminho: "/api/point/cobrar",
      headers: { "content-type": "application/json" },
      corpo: JSON.stringify({ tipo: "debit_card", valor: 1 })
    });
    assert.equal(cobrar.status, 401);

    const pre = await pedir(port, {
      metodo: "OPTIONS",
      caminho: "/api/point/cobrar",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" }
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "http://localhost:5173");

    const estranha = await pedir(port, { metodo: "OPTIONS", caminho: "/api/point/cobrar", headers: { origin: "https://site-malicioso.example" } });
    assert.equal(estranha.headers["access-control-allow-origin"], undefined, "origem fora da lista não recebe CORS");
  });
});

// ── Banner de abertura ───────────────────────────────────────────────────
const FIREBASE_OK = { ok: true, projectId: "flora-5754a" };

test("banner: mostra o que está configurado sem nunca imprimir valor de segredo", () => {
  const env = { MP_ACCESS_TOKEN: "APP_USR-SEGREDO-123", MP_POINT_TERMINAL_ID: "PAX_A910__SMARTPOS1", MP_WEBHOOK_SECRET: "WEBHOOK-SEGREDO" };
  const texto = linhasDoBanner({ url: "http://127.0.0.1:3001", env, firebase: FIREBASE_OK, envCarregado: true }).join("\n");
  assert.match(texto, /127\.0\.0\.1:3001/);
  assert.match(texto, /MP_ACCESS_TOKEN\.+ ok/);
  assert.match(texto, /MP_POINT_TERMINAL_ID\.+ PAX_A910__SMARTPOS1/);
  assert.match(texto, /projeto flora-5754a/);
  assert.equal(/SEGREDO/.test(texto), false);
});

test("banner: sinaliza o que falta e sugere o comando pra resolver", () => {
  const texto = linhasDoBanner({
    url: "http://127.0.0.1:3001",
    env: {},
    firebase: { ok: false, mensagem: "FIREBASE_SERVICE_ACCOUNT não configurada" },
    envCarregado: false
  }).join("\n");
  assert.match(texto, /Não achei o arquivo \.env/);
  assert.match(texto, /MP_ACCESS_TOKEN\.+ FALTANDO/);
  assert.match(texto, /MP_POINT_TERMINAL_ID\.+ FALTANDO.*point:check/);
  assert.match(texto, /não configurada \(ok pros primeiros testes\)/);
  assert.match(texto, /ERRO: FIREBASE_SERVICE_ACCOUNT não configurada/);
});

test("banner: credencial de teste (TEST-) é avisada", () => {
  const texto = linhasDoBanner({ url: "u", env: { MP_ACCESS_TOKEN: "TEST-123" }, firebase: FIREBASE_OK, envCarregado: true }).join("\n");
  assert.match(texto, /credencial de TESTE/);
  assert.equal(texto.includes("TEST-123"), false);
});
