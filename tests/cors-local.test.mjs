import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { liberarFrontLocal, ORIGENS_FRONT_LOCAL } from "../scripts/lib/cors-local.mjs";
import { criarServidor, ROTAS_REAIS } from "../scripts/api-dev.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exigir = createRequire(import.meta.url);
const [LOCALHOST, LOOPBACK] = ORIGENS_FRONT_LOCAL;

test("liberarFrontLocal: CORS_ORIGINS vazio ou ausente não é mexido (a API já usa o padrão, que inclui o sistema local)", () => {
  for (const valor of [undefined, "", "   ", " , ,"]) {
    const env = valor === undefined ? {} : { CORS_ORIGINS: valor };
    const antes = JSON.stringify(env);
    assert.deepEqual(liberarFrontLocal(env), { adicionadas: [] });
    assert.equal(JSON.stringify(env), antes, `env não deveria mudar com ${JSON.stringify(valor)}`);
  }
});

test("liberarFrontLocal: só a Vercel no .env → mantém a Vercel e acrescenta o sistema local", () => {
  const env = { CORS_ORIGINS: "https://sistema-amira.vercel.app" };
  const r = liberarFrontLocal(env);
  assert.deepEqual(r.adicionadas, ORIGENS_FRONT_LOCAL);
  assert.equal(env.CORS_ORIGINS, `https://sistema-amira.vercel.app, ${LOCALHOST}, ${LOOPBACK}`);
});

test("liberarFrontLocal: acrescenta só o que falta e não duplica (barra final e espaços não enganam)", () => {
  const env = { CORS_ORIGINS: ` https://a.app/ ,  ${LOCALHOST}/ ` };
  const r = liberarFrontLocal(env);
  assert.deepEqual(r.adicionadas, [LOOPBACK]);
  assert.equal(env.CORS_ORIGINS, `https://a.app, ${LOCALHOST}, ${LOOPBACK}`);
});

test("liberarFrontLocal: já tem tudo → não altera nada; e é idempotente", () => {
  const env = { CORS_ORIGINS: `${LOCALHOST},${LOOPBACK}` };
  assert.deepEqual(liberarFrontLocal(env), { adicionadas: [] });
  assert.equal(env.CORS_ORIGINS, `${LOCALHOST},${LOOPBACK}`, "valor original preservado");

  const env2 = { CORS_ORIGINS: "https://x.app" };
  liberarFrontLocal(env2);
  const depoisDaPrimeira = env2.CORS_ORIGINS;
  assert.deepEqual(liberarFrontLocal(env2), { adicionadas: [] });
  assert.equal(env2.CORS_ORIGINS, depoisDaPrimeira);
});

test("liberarFrontLocal: nunca libera origem que não seja o sistema local", () => {
  const env = { CORS_ORIGINS: "https://sistema-amira.vercel.app" };
  liberarFrontLocal(env);
  const lista = env.CORS_ORIGINS.split(",").map((s) => s.trim());
  assert.deepEqual(lista, ["https://sistema-amira.vercel.app", LOCALHOST, LOOPBACK]);
  assert.equal(lista.includes("*"), false);
});

// ── Regressão do erro real: "No 'Access-Control-Allow-Origin' header is present" ──
function preflight(port, origem) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "OPTIONS",
        path: "/api/point/diagnostico",
        headers: { origin: origem, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("regressão: CORS_ORIGINS só com a Vercel bloqueava o sistema local; com liberarFrontLocal o preflight passa", async () => {
  const rotas = Object.fromEntries(Object.entries(ROTAS_REAIS).map(([rota, arquivo]) => [rota, exigir(path.join(RAIZ, arquivo))]));
  const servidor = criarServidor(rotas);
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  const { port } = servidor.address();
  const guardado = process.env.CORS_ORIGINS;

  try {
    // O .env do usuário: só a URL da Vercel (o handler lê process.env a cada chamada).
    process.env.CORS_ORIGINS = "https://sistema-amira.vercel.app";

    const antes = await preflight(port, LOCALHOST);
    assert.equal(antes.headers["access-control-allow-origin"], undefined, "sem a correção o navegador bloquearia (era o bug)");

    liberarFrontLocal(process.env);

    const depois = await preflight(port, LOCALHOST);
    assert.equal(depois.status, 204);
    assert.equal(depois.headers["access-control-allow-origin"], LOCALHOST);
    assert.match(depois.headers["access-control-allow-headers"], /Authorization/i, "o header do token de login precisa ser aceito");

    // o que já estava liberado continua, e o resto continua bloqueado
    assert.equal((await preflight(port, "https://sistema-amira.vercel.app")).headers["access-control-allow-origin"], "https://sistema-amira.vercel.app");
    assert.equal((await preflight(port, "https://site-malicioso.example")).headers["access-control-allow-origin"], undefined);
  } finally {
    if (guardado === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = guardado;
    await new Promise((ok) => servidor.close(ok));
  }
});
