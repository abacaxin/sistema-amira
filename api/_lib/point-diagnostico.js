// ── Diagnóstico da conexão com a maquininha ────────────────────────────
// Confere, item por item, o que precisa estar certo pra a primeira cobrança
// funcionar, e diz EXATAMENTE o que falta. Usado em três lugares com a mesma
// lógica: GET /api/point/diagnostico (botão "Testar conexão" em
// Configurações), o CLI `npm run point:check` e (indiretamente) o banner do
// `npm run api:dev`. Nunca devolve valor de segredo — só se está presente e
// o que o Mercado Pago respondeu sobre ele.
//
// Cada item: { id, nivel: "ok"|"aviso"|"erro", titulo, detalhe, acao? }.
// `ok` no resultado = nenhum item em "erro" (aviso não impede cobrar).

const { origensPermitidas } = require("./cors");
const { mapearTerminais, compactar } = require("./point");

// Projeto Firebase da loja. Só serve pra avisar: com a chave de OUTRO projeto
// todo login do sistema é recusado (o token não bate com o projeto).
const PROJETO_ESPERADO = "flora-5754a";

/**
 * @param {{
 *   env: object,
 *   mp: { usuarioAtual():Promise<object>, listarTerminais():Promise<object> },
 *   checarFirebase: () => Promise<{projectId:string}>   // lança se a service account/Firestore não funcionarem
 * }} deps
 */
async function diagnosticar({ env, mp, checarFirebase }) {
  const checks = [];
  const add = (nivel, id, titulo, detalhe, acao) => checks.push(compactar({ id, nivel, titulo, detalhe, acao }));
  const msg = (e) => (e && (e.publico || e.message)) || String(e);

  // 1) Access Token do Mercado Pago
  const token = String(env.MP_ACCESS_TOKEN || "").trim();
  let tokenOk = false;
  if (!token) {
    add(
      "erro", "token_mp", "Access Token do Mercado Pago", "MP_ACCESS_TOKEN não está configurada.",
      "Painel do Mercado Pago → Suas integrações → sua aplicação → Credenciais de produção → copie o Access Token (APP_USR-…) pra MP_ACCESS_TOKEN."
    );
  } else {
    try {
      const eu = await mp.usuarioAtual();
      tokenOk = true;
      const quem = eu.nickname || eu.first_name || `conta ${eu.id}`;
      if (token.startsWith("TEST-")) {
        add(
          "aviso", "token_mp", "Access Token do Mercado Pago",
          `Válido, mas são credenciais de TESTE (${quem}). A maquininha real só aceita credenciais de produção.`,
          "Use o Access Token de produção da aplicação."
        );
      } else {
        add("ok", "token_mp", "Access Token do Mercado Pago", `Válido — ${quem} (id ${eu.id}${eu.site_id ? `, ${eu.site_id}` : ""}).`);
      }
    } catch (e) {
      add(
        "erro", "token_mp", "Access Token do Mercado Pago", msg(e),
        "Confira se copiou o Access Token de PRODUÇÃO inteiro, da mesma conta que é dona da maquininha."
      );
    }
  }

  // 2) Firebase (service account + Firestore)
  try {
    const { projectId } = await checarFirebase();
    if (projectId !== PROJETO_ESPERADO) {
      add(
        "aviso", "firebase", "Firebase (service account)",
        `Conectou no projeto "${projectId}", mas o sistema é do "${PROJETO_ESPERADO}" — os logins vão ser recusados.`,
        `Gere a chave da service account no projeto ${PROJETO_ESPERADO}.`
      );
    } else {
      add("ok", "firebase", "Firebase (service account)", `Conectou no Firestore do projeto ${projectId}.`);
    }
  } catch (e) {
    add(
      "erro", "firebase", "Firebase (service account)", msg(e),
      "Configure FIREBASE_SERVICE_ACCOUNT (JSON ou base64 da service account do projeto flora-5754a) — ou, só no teste local, deixe o serviceAccount.json na raiz do repositório."
    );
  }

  // 3) Terminais da conta
  let terminais = [];
  let listou = false;
  if (!tokenOk) {
    add("aviso", "terminais", "Terminais da conta", "Não consultado — o Access Token não está válido.");
  } else {
    try {
      terminais = mapearTerminais(await mp.listarTerminais(), env.MP_POINT_TERMINAL_ID);
      listou = true;
      if (!terminais.length) {
        add(
          "erro", "terminais", "Terminais da conta", "O Mercado Pago não listou nenhum terminal nessa conta.",
          "Crie a loja e o caixa no painel do MP e vincule a maquininha pelo app (QR Code no terminal). O terminal precisa ser Point Smart 1/2 ou Point Pro 2/3."
        );
      } else {
        add(
          "ok", "terminais", "Terminais da conta",
          `${terminais.length} terminal(is): ${terminais.map((t) => `${t.id} (${t.modo || "?"})`).join("; ")}.`
        );
      }
    } catch (e) {
      add("erro", "terminais", "Terminais da conta", msg(e), "Confira o Access Token e se a conta tem a maquininha vinculada.");
    }
  }

  // 4) Terminal desta loja (variável) e modo PDV
  const configurado = String(env.MP_POINT_TERMINAL_ID || "").trim();
  if (!configurado) {
    add(
      "erro", "terminal_configurado", "Terminal desta loja", "MP_POINT_TERMINAL_ID não está configurado.",
      terminais.length === 1
        ? `Use o id ${terminais[0].id} (npm run point:check -- --gravar grava no .env).`
        : "Copie o id do terminal certo (lista acima) pra MP_POINT_TERMINAL_ID."
    );
  } else if (!listou || !terminais.length) {
    add("aviso", "terminal_configurado", "Terminal desta loja", `MP_POINT_TERMINAL_ID = ${configurado} (não deu pra conferir na lista).`);
  } else {
    const t = terminais.find((x) => x.id === configurado);
    if (!t) {
      add(
        "erro", "terminal_configurado", "Terminal desta loja",
        `MP_POINT_TERMINAL_ID = ${configurado}, que não é nenhum terminal da conta.`,
        `Use um destes: ${terminais.map((x) => x.id).join(", ")}.`
      );
    } else if (t.modo !== "PDV") {
      add(
        "erro", "terminal_configurado", "Terminal desta loja", `${configurado} está em modo ${t.modo || "desconhecido"}, não em PDV.`,
        "Configurações → Maquininha → “Colocar em modo PDV” (ou npm run point:check -- --colocar-pdv)."
      );
    } else {
      add("ok", "terminal_configurado", "Terminal desta loja", `${configurado} está em modo PDV — pronto pra receber cobranças.`);
    }
  }

  // 5) Webhook (opcional)
  if (!String(env.MP_WEBHOOK_SECRET || "").trim()) {
    add(
      "aviso", "webhook", "Assinatura do webhook", "MP_WEBHOOK_SECRET não configurada.",
      "Opcional pros primeiros testes (o sistema atualiza consultando o MP). Antes de usar de verdade: Webhooks → tópico Order → copie a assinatura secreta."
    );
  } else {
    add("ok", "webhook", "Assinatura do webhook", "MP_WEBHOOK_SECRET configurada.");
  }

  // 6) CORS (informativo)
  add("ok", "cors", "Origens que podem chamar a API", origensPermitidas(env).join(", "));

  return {
    ok: !checks.some((c) => c.nivel === "erro"),
    checks,
    terminais,
    configurado: configurado || null
  };
}

module.exports = { diagnosticar, PROJETO_ESPERADO };
