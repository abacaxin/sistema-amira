// ── Liga as dependências REAIS nos handlers da maquininha ──────────────
// Único lugar que importa firebase-admin e o cliente do Mercado Pago. Os
// arquivos em api/point/*.js só reexportam um handler daqui. (Os testes
// usam criarHandlers() direto, com dependências falsas.)

const { getDb, checarFirebase, tokenDaRequisicao, exigirStaff, exigirAdmin } = require("./firebase-admin");
const { limitar } = require("./limite");
const mp = require("./mercadopago");
const { criarHandlers } = require("./point-handlers");

module.exports = criarHandlers({ getDb, exigirStaff, exigirAdmin, mp, limitar, tokenDaRequisicao, checarFirebase });
