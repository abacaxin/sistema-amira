// ── Firebase Admin SDK para as funções serverless ──────────────────────
// Adaptado do backend do site (repo Amira, api/_lib/firebase-admin.js).
// A service account vai numa Environment Variable da Vercel
// (FIREBASE_SERVICE_ACCOUNT) — o JSON INTEIRO, ou em base64. NUNCA
// commitar o valor. Ver .env.example.
//
// Inicialização PREGUIÇOSA: se a env var faltar ou estiver malformada, o
// erro estoura DENTRO do handler (vira um 500 com JSON), não no load do
// módulo (que viraria FUNCTION_INVOCATION_FAILED, difícil de depurar).
//
// ⚠️ NÃO importa "firebase-admin/auth", de propósito (arrasta jose, ESM
// puro, que derruba o processo em Node antigo — ver _lib/id-token.js).
// Só o Firestore vem do firebase-admin.
//
// ⚠️ Este é o MESMO projeto Firebase do site e da loja (flora-5754a): o
// Admin SDK passa por cima das firestore.rules, então toda função aqui
// precisa conferir QUEM está chamando (exigirStaff / exigirAdmin).

const fs = require("fs");
const path = require("path");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { verificarIdToken } = require("./id-token");
const { papelDaEquipe } = require("./equipe");
const { erroHttp } = require("./http");

let _db = null;

// Só pro desenvolvimento local (npm run api:dev / point:check): sem a env
// var, usa o mesmo arquivo que os scripts Python já usam — o caminho em
// GOOGLE_APPLICATION_CREDENTIALS ou o serviceAccount.json na raiz do repo
// (que está no .gitignore). Na Vercel nenhum dos dois existe, então o
// comportamento lá não muda.
function caminhosLocais(env = process.env) {
  return [
    env.GOOGLE_APPLICATION_CREDENTIALS,
    path.resolve(__dirname, "../../serviceAccount.json"),
    path.join(process.cwd(), "serviceAccount.json")
  ].filter(Boolean);
}

function lerServiceAccountLocal(caminhos) {
  for (const caminho of caminhos) {
    try {
      return fs.readFileSync(caminho, "utf8");
    } catch {
      /* tenta o próximo */
    }
  }
  return "";
}

// `env` e `caminhos` só existem pros testes (não dependerem do ambiente de
// quem roda); em produção e no uso normal ficam nos padrões.
function credenciais({ env = process.env, caminhos = caminhosLocais(env) } = {}) {
  let bruto = env.FIREBASE_SERVICE_ACCOUNT;
  if (!bruto || !bruto.trim()) bruto = lerServiceAccountLocal(caminhos);
  if (!bruto || !bruto.trim()) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT não configurada nas Environment Variables da Vercel " +
        "(no teste local, também vale um serviceAccount.json na raiz do repositório)."
    );
  }
  bruto = bruto.trim();

  // Aceita o JSON cru OU em base64 (o base64 evita quebra de linha na
  // private_key ao colar no painel).
  if (!bruto.startsWith("{")) {
    try {
      const decodificado = Buffer.from(bruto, "base64").toString("utf8").trim();
      if (decodificado.startsWith("{")) bruto = decodificado;
    } catch {
      /* segue com o valor original */
    }
  }

  let obj;
  try {
    obj = JSON.parse(bruto);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT não é um JSON válido. Cole o conteúdo inteiro do " +
        "arquivo (de um editor de texto puro) OU o arquivo em base64."
    );
  }

  if (typeof obj.private_key === "string") {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }
  if (!obj.project_id || !obj.private_key || !obj.client_email) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT incompleta (faltam project_id / private_key / client_email).");
  }
  return obj;
}

/** credenciais(), mas o erro de configuração já sai marcado como 500 público. */
function credenciaisOuFalhaConfig() {
  try {
    return credenciais();
  } catch (erro) {
    throw erroHttp(500, `Erro de configuração do servidor: ${erro.message}`);
  }
}

/** Firestore (Admin). Inicializa na primeira chamada. */
function getDb() {
  if (_db) return _db;
  const app = getApps()[0] || initializeApp({ credential: cert(credenciaisOuFalhaConfig()) });
  _db = getFirestore(app);
  return _db;
}

/**
 * Prova que a service account existe e que o Firestore responde (usado só
 * pelo diagnóstico da maquininha e pelo `npm run point:check`). Lança com a
 * mensagem do problema; devolve o projeto em que conectou.
 */
async function checarFirebase() {
  const cred = credenciais();
  await getDb().collection("configuracoes").doc("sistema").get();
  return { projectId: cred.project_id };
}

/** Lê o ID token do header Authorization (ou do corpo, campo idToken). */
function tokenDaRequisicao(req) {
  const doCorpo = req && req.body && typeof req.body === "object" && req.body.idToken;
  const doHeader = ((req && req.headers && req.headers.authorization) || "").replace(/^Bearer\s+/i, "");
  return String(doHeader || doCorpo || "").trim();
}

async function autenticar(idToken, { soAdmin }) {
  if (!idToken) throw erroHttp(401, "Entre no sistema para continuar.");

  // Busca da credencial FORA do try: erro de configuração não pode virar
  // "sessão expirada" (escondia problema de infra atrás de mensagem de login).
  const projeto = credenciaisOuFalhaConfig().project_id;
  let decodificado;
  try {
    decodificado = await verificarIdToken(String(idToken), projeto);
  } catch (erro) {
    // Falha de REDE ao buscar as chaves do Google não é token inválido.
    if (/chaves públicas/.test(erro.message)) {
      throw erroHttp(503, "Não foi possível validar sua sessão agora. Tente em instantes.");
    }
    throw erroHttp(401, "Sessão expirada. Entre de novo no sistema para continuar.");
  }

  const snap = await getDb().collection("usuarios").doc(decodificado.uid).get();
  const perfil = snap.exists ? snap.data() : null;
  const papel = papelDaEquipe(perfil);
  if (!papel || (soAdmin && papel !== "admin")) {
    throw erroHttp(403, soAdmin ? "Só administradores podem fazer isso." : "Só a equipe da loja pode usar a maquininha.");
  }
  return { uid: decodificado.uid, email: decodificado.email || "", role: papel, nome: (perfil && perfil.nome) || "" };
}

/** Verifica o ID token e exige admin OU vendedor ativo. */
function exigirStaff(idToken) {
  return autenticar(idToken, { soAdmin: false });
}

/** Verifica o ID token e exige admin. */
function exigirAdmin(idToken) {
  return autenticar(idToken, { soAdmin: true });
}

module.exports = { getDb, credenciais, checarFirebase, tokenDaRequisicao, exigirStaff, exigirAdmin };
