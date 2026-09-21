// ── Utilitários HTTP das funções serverless ────────────────────────────
// Convenção herdada do backend do site: todo erro "esperado" carrega
// `.status` (HTTP) e `.publico` (mensagem segura pra mostrar na tela).
// Erro sem `.status` é bug/infra: vira 500 genérico e o detalhe fica só no
// log da Vercel.

function erroHttp(status, mensagem, extra) {
  const e = new Error(mensagem);
  e.status = status;
  e.publico = mensagem;
  return extra ? Object.assign(e, extra) : e;
}

/** Corpo JSON da requisição (a Vercel já entrega objeto; aceita string por garantia). */
function corpoJson(req) {
  const b = req && req.body;
  if (b === undefined || b === null || b === "") return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      throw erroHttp(400, "O corpo da requisição não é um JSON válido.");
    }
  }
  return typeof b === "object" ? b : {};
}

/**
 * Responde um erro no formato { erro: "mensagem" } com o status certo. Se o
 * erro traz `.codigo` (ex.: "na_maquininha"), vai junto: a tela usa pra agir
 * diferente sem ter que interpretar o texto.
 */
function responderErro(res, erro) {
  const status = erro && erro.status ? erro.status : 500;
  if (status >= 500) {
    console.error("[api]", erro && erro.message, erro && erro.detalhe ? JSON.stringify(erro.detalhe) : "");
  }
  const mensagem =
    (erro && erro.publico) ||
    (status >= 500 ? "Erro interno. Tente de novo em instantes." : (erro && erro.message) || "Requisição inválida.");
  if (erro && erro.retryApos) res.setHeader("Retry-After", String(erro.retryApos));
  return res.status(status).json({ erro: mensagem, ...(erro && erro.codigo ? { codigo: String(erro.codigo) } : {}) });
}

module.exports = { erroHttp, corpoJson, responderErro };
