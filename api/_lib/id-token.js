// ── Verificação do ID token do Firebase, sem o firebase-admin/auth ─────
// Copiado do backend do site (repo Amira, api/_lib/id-token.js) — mesma
// conferência, mesmo motivo. Se mexer aqui, veja se vale mexer lá também.
//
// POR QUE ISTO EXISTE: o verifyIdToken do firebase-admin arrasta
// jwks-rsa → jose, e jose 6 é ESM puro. Em Node abaixo de 20.19/22.12 o
// require() disso DERRUBA O PROCESSO (ERR_REQUIRE_ESM), antes de qualquer
// try/catch. Isso já tirou o pagamento do ar e escondeu o erro do cadastro
// de revendedor por dias, porque a função morria sem responder.
//
// Aqui a verificação é feita com jsonwebtoken (CommonJS) e as chaves
// públicas do Google. Mesmo resultado, sem depender da versão do Node.
//
// A CONFERÊNCIA É A MESMA QUE O SDK FAZ (documentação do Firebase,
// "Verify ID tokens using a third-party JWT library"):
//   • assinatura RS256 contra a chave pública do Google do "kid" do token
//   • algoritmo FIXADO em RS256 — sem isso, um token com alg "none" ou
//     HS256 assinado com a própria chave pública passaria
//   • aud  == projectId
//   • iss  == https://securetoken.google.com/<projectId>
//   • exp/iat — o jsonwebtoken já recusa expirado
//   • sub   — não vazio; é o uid

const jwt = require("jsonwebtoken");

const URL_CERTIFICADOS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// O Google roda as chaves de tempos em tempos e diz por quanto tempo elas
// valem no Cache-Control. Buscar a cada chamada seria uma ida à rede em
// toda cobrança.
let cacheChaves = null;
let cacheExpiraEm = 0;
const VALIDADE_PADRAO_MS = 60 * 60 * 1000;

async function chavesPublicas() {
  if (cacheChaves && Date.now() < cacheExpiraEm) return cacheChaves;

  const resposta = await fetch(URL_CERTIFICADOS);
  if (!resposta.ok) {
    throw new Error(`Não foi possível buscar as chaves públicas do Google (HTTP ${resposta.status}).`);
  }
  const chaves = await resposta.json();

  const maxAge = /max-age=(\d+)/i.exec(resposta.headers.get("cache-control") || "");
  cacheChaves = chaves;
  cacheExpiraEm = Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : VALIDADE_PADRAO_MS);
  return chaves;
}

function cabecalhoDoToken(token) {
  const parte = String(token).split(".")[0];
  if (!parte) throw new Error("Token malformado.");
  return JSON.parse(Buffer.from(parte, "base64").toString("utf8"));
}

/**
 * Verifica um ID token do Firebase e devolve o payload.
 * Lança em qualquer inconsistência — nunca devolve payload não conferido.
 *
 * @param {string} token
 * @param {string} projectId  o mesmo projeto da service account
 * @returns {Promise<{uid: string, email: string, payload: object}>}
 */
async function verificarIdToken(token, projectId) {
  if (!token || typeof token !== "string") throw new Error("Sem token.");
  if (!projectId) throw new Error("Sem projectId para conferir o token.");

  const cabecalho = cabecalhoDoToken(token);
  if (cabecalho.alg !== "RS256") {
    throw new Error(`Algoritmo inesperado no token: ${cabecalho.alg}`);
  }
  if (!cabecalho.kid) throw new Error("Token sem kid.");

  const chaves = await chavesPublicas();
  const certificado = chaves[cabecalho.kid];
  if (!certificado) {
    // Pode ser rotação de chave com cache velho: limpa e tenta de novo.
    cacheChaves = null;
    const novas = await chavesPublicas();
    if (!novas[cabecalho.kid]) throw new Error("O token não corresponde a nenhuma chave do Google.");
    return conferir(token, novas[cabecalho.kid], projectId);
  }
  return conferir(token, certificado, projectId);
}

function conferir(token, certificado, projectId) {
  const payload = jwt.verify(token, certificado, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Token sem uid (sub).");
  }
  // auth_time no futuro significa token forjado ou relógio fora de hora.
  if (payload.auth_time && payload.auth_time > Math.floor(Date.now() / 1000) + 60) {
    throw new Error("Token com auth_time no futuro.");
  }

  return { uid: payload.sub, email: payload.email || "", payload };
}

module.exports = { verificarIdToken };
