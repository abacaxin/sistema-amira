// CORS do teste local (npm run api:dev / npm run point:check).
//
// No teste local o sistema roda em http://localhost:5173 e a API em
// http://127.0.0.1:3001: são origens diferentes, então o navegador só deixa
// o sistema chamar a API se ela responder o CORS liberando o sistema.
//
// Só que um CORS_ORIGINS no .env (copiado da Vercel, por exemplo) SUBSTITUI a
// lista padrão da API e deixa o sistema local de fora — o navegador então
// bloqueia tudo com "No 'Access-Control-Allow-Origin' header is present" e a
// tela só mostra "Sem conexão", mesmo com a API de pé. Aqui garantimos que o
// sistema local está na lista, sem tirar nenhuma origem que o .env já tinha.

export const ORIGENS_FRONT_LOCAL = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Acrescenta o sistema local ao CORS_ORIGINS de `env` (muda `env`).
 * Vazio = a API usa a lista padrão, que já inclui o sistema local: não mexe.
 * @returns {{adicionadas: string[]}} as origens que faltavam e foram acrescentadas
 */
export function liberarFrontLocal(env = process.env) {
  const configuradas = String(env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (!configuradas.length) return { adicionadas: [] };

  const faltando = ORIGENS_FRONT_LOCAL.filter((origem) => !configuradas.includes(origem));
  if (faltando.length) env.CORS_ORIGINS = [...configuradas, ...faltando].join(", ");
  return { adicionadas: faltando };
}
