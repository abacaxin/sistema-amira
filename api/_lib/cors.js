// ── CORS das funções /api ──────────────────────────────────────────────
// O front do sistema fica no Firebase Hosting (flora-5754a-interno.web.app)
// e a API na Vercel: são origens diferentes, e o navegador só deixa o
// fetch com header Authorization passar se a API responder o preflight.
// Se o front for servido pela própria Vercel (mesma origem), nada disso é
// usado. Só as origens da lista podem chamar — nunca "*".

const ORIGENS_PADRAO = [
  "https://flora-5754a-interno.web.app",
  "https://flora-5754a-interno.firebaseapp.com",
  "http://localhost:5173"
];

function origensPermitidas(env = process.env) {
  const extras = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return extras.length ? extras : ORIGENS_PADRAO;
}

/**
 * Aplica os headers de CORS e responde o preflight.
 * @returns {boolean} true se a requisição era um preflight (OPTIONS) e já
 *                    foi respondida — o handler deve parar.
 */
function aplicarCors(req, res, env = process.env) {
  const origem = req.headers && req.headers.origin;
  if (origem && origensPermitidas(env).includes(origem)) {
    res.setHeader("Access-Control-Allow-Origin", origem);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { aplicarCors, origensPermitidas };
