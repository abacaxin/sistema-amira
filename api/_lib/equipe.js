// ── Quem é "equipe da loja" ────────────────────────────────────────────
// Espelha as firestore.rules (ehAdmin / ehVendedor / ehStaff) — o Admin SDK
// ignora as rules, então a função precisa refazer essa conferência na mão.
// O papel NÃO vem do token: é lido de usuarios/{uid}, a mesma fonte das rules.

/**
 * @param {object|null} perfil  documento usuarios/{uid}
 * @returns {"admin"|"vendedor"|null}
 */
function papelDaEquipe(perfil) {
  if (!perfil) return null;
  if (perfil.role === "admin") return "admin";
  // Vendedor só conta se estiver ATIVO (mesma regra de ehVendedor()).
  if (perfil.role === "vendedor" && perfil.ativo === true) return "vendedor";
  return null;
}

module.exports = { papelDaEquipe };
