// ── POST /api/webhook-point ───────────────────────────────────────────
// Notificação do Mercado Pago (tópico "orders") sobre a cobrança na
// maquininha. Configure em: Suas integrações → (aplicação) → Webhooks →
// tópico "Order (Mercado Pago)" → URL https://<esta-api>/api/webhook-point.
// Lógica em _lib/point-handlers.js.
module.exports = require("./_lib/point-runtime").webhook;
