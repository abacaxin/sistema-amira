// Verificador de ID token (copiado do backend do site). O que importa aqui
// é a lista de RECUSAS — um verificador que só aceita token bom não prova
// nada. Não usa rede nem Firebase: um par de chaves local faz o papel do Google.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubPem = publicKey.export({ type: "spki", format: "pem" });
const KID = "chave-de-teste";
const PROJETO = "flora-5754a";

// Cada arquivo roda em processo próprio: trocar o fetch global é seguro.
globalThis.fetch = async () => ({
  ok: true,
  headers: { get: () => "max-age=3600" },
  json: async () => ({ [KID]: pubPem })
});

const { verificarIdToken } = require("../api/_lib/id-token");

const agora = Math.floor(Date.now() / 1000);
const base = {
  sub: "uid-da-pessoa",
  email: "vendedora@exemplo.com",
  aud: PROJETO,
  iss: `https://securetoken.google.com/${PROJETO}`,
  iat: agora - 60,
  exp: agora + 3600,
  auth_time: agora - 60
};
const assinar = (p, opts = {}) => jwt.sign(p, privateKey, { algorithm: "RS256", keyid: KID, ...opts });
const outraChave = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

// alg none e HS256 assinado com a chave PÚBLICA — os dois ataques clássicos
const semAssinatura =
  Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url") +
  "." +
  Buffer.from(JSON.stringify(base)).toString("base64url") +
  ".";

test("aceita o token legítimo e devolve uid/email", async () => {
  const r = await verificarIdToken(assinar(base), PROJETO);
  assert.equal(r.uid, "uid-da-pessoa");
  assert.equal(r.email, "vendedora@exemplo.com");
});

const recusas = [
  ["expirado", () => assinar({ ...base, exp: agora - 10 })],
  ["aud de outro projeto", () => assinar({ ...base, aud: "projeto-do-atacante" })],
  ["iss forjado", () => assinar({ ...base, iss: "https://evil.example/" })],
  ["sem sub (uid)", () => assinar({ ...base, sub: undefined })],
  ["auth_time no futuro", () => assinar({ ...base, auth_time: agora + 9999 })],
  ["assinado com OUTRA chave", () => jwt.sign(base, outraChave, { algorithm: "RS256", keyid: KID })],
  ["kid desconhecido", () => assinar(base, { keyid: "kid-que-nao-existe" })],
  ["alg: none", () => semAssinatura],
  ["HS256 com a chave pública", () => jwt.sign(base, pubPem, { algorithm: "HS256", keyid: KID })],
  ["token vazio", () => ""],
  ["lixo", () => "isto.nao.e-um-jwt"]
];

for (const [nome, fabricar] of recusas) {
  test(`recusa: ${nome}`, async () => {
    await assert.rejects(() => verificarIdToken(fabricar(), PROJETO));
  });
}

test("recusa quando falta o projectId", async () => {
  await assert.rejects(() => verificarIdToken(assinar(base), ""), /projectId/);
});
