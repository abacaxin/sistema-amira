// ── Handlers da maquininha Point (fábrica com dependências injetadas) ───
// Toda a lógica das rotas mora aqui, recebendo Firestore / Mercado Pago /
// autenticação por parâmetro. Os arquivos em api/point/*.js só ligam as
// dependências reais (ver point-runtime.js). Assim os testes rodam com um
// Firestore e um MP falsos, sem rede e sem credencial.
//
// Desenho (resumo):
//   • O PDV chama /cobrar → criamos a order no MP (a maquininha acende) e
//     guardamos cobrancas_point/{cobrancaId} (só o Admin SDK escreve/lê:
//     o catch-all das firestore.rules fecha a coleção pro cliente).
//   • O PDV consulta /status a cada poucos segundos. Cada consulta
//     ATUALIZA o estado direto no MP — então o fluxo funciona mesmo sem o
//     webhook configurado; o webhook é só a rede de segurança (cobrança
//     aprovada que ninguém está mais acompanhando).
//   • Estado só avança (podeAvancar): uma resposta velha nunca desfaz uma
//     nova, seja do polling ou do webhook.

const crypto = require("crypto");
const { aplicarCors } = require("./cors");
const { erroHttp, corpoJson, responderErro } = require("./http");
const {
  validarCobranca,
  montarOrderPoint,
  primeiroPagamento,
  normalizarOrder,
  trocarCampoQuemPagaJuros,
  mapearTerminais,
  extrairTaxas,
  podeAvancar,
  compactar,
  projetarCobranca
} = require("./point");
const { diagnosticar } = require("./point-diagnostico");

const COLECAO = "cobrancas_point";
const ID_COBRANCA = /^[A-Za-z0-9_-]{8,60}$/;

// Assinatura do MP (x-signature). manifest = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// mas cada segmento SÓ entra se o valor existir (spec do MP). Retorna
// "ok" | "sem-assinatura" | "sem-segredo" | "nao-confere". Mesma lógica
// do webhook do site.
function checarAssinatura(req, dataId, env) {
  const secret = env.MP_WEBHOOK_SECRET;
  if (!secret) return "sem-segredo";

  const assinatura = (req.headers && req.headers["x-signature"]) || "";
  const requestId = (req.headers && req.headers["x-request-id"]) || "";
  if (!assinatura) return "sem-assinatura";

  const partes = {};
  for (const p of assinatura.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const { ts, v1 } = partes;
  if (!ts || !v1) return "sem-assinatura";

  // data.id alfanumérico deve ir em minúsculas (spec do MP).
  const id = /[a-zA-Z]/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);

  let manifest = "";
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${ts};`;

  const esperado = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(esperado, "hex")) ? "ok" : "nao-confere";
  } catch {
    return "nao-confere";
  }
}

function criarHandlers({ getDb, exigirStaff, exigirAdmin, mp, limitar, tokenDaRequisicao, checarFirebase, env = process.env, agora = () => new Date() }) {
  const podeMexer = (staff, d) => staff.role === "admin" || d.vendedor_uid === staff.uid;

  function idDaQuery(req) {
    const id = String((req.query && req.query.cobrancaId) || (req.body && req.body.cobrancaId) || "");
    if (!ID_COBRANCA.test(id)) throw erroHttp(400, "Identificador da cobrança inválido.");
    return id;
  }

  async function carregar(db, id, staff) {
    const ref = db.collection(COLECAO).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw erroHttp(404, "Cobrança não encontrada.");
    const d = snap.data();
    if (staff && !podeMexer(staff, d)) throw erroHttp(403, "Esta cobrança é de outra pessoa.");
    return { ref, d };
  }

  // Busca as taxas reais só quando a order acabou de ser aprovada e ainda
  // não temos (chamada de rede — por isso fica FORA da transação). Qualquer
  // falha aqui é não-fatal: o PDV cai na estimativa da tabela de juros.
  async function buscarTaxas(order, docAtual) {
    const norm = normalizarOrder(order);
    if (!norm.aprovado || docAtual.taxa_origem) return { taxas: null, classico: null };

    const pg = primeiroPagamento(order) || {};
    let classico = null;
    if (norm.payment_ref && /^\d+$/.test(norm.payment_ref)) {
      try {
        classico = await mp.buscarPagamento(norm.payment_ref);
      } catch (erro) {
        console.warn("[point] não consegui buscar as taxas em /v1/payments:", erro && erro.message);
      }
    }
    return { taxas: extrairTaxas({ valor: docAtual.valor, pagamentoOrder: pg, pagamentoClassico: classico }), classico };
  }

  // Aplica uma order do MP no documento. Transação + podeAvancar: resposta
  // atrasada nunca regride um estado mais novo (polling e webhook correm
  // em paralelo).
  async function sincronizar(db, ref, order, docAtual) {
    const norm = normalizarOrder(order);
    const { taxas, classico } = await buscarTaxas(order, docAtual);

    return db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return null;
      const atual = snap.data();
      if (!podeAvancar(atual.status, norm.status)) return atual;

      const campos = compactar({
        ...norm,
        ...(taxas || {}),
        // valor_pago das taxas (API clássica) é mais confiável que o da order
        valor_pago: taxas && taxas.valor_pago !== null ? taxas.valor_pago : norm.valor_pago,
        mp_raw: order,
        mp_pagamento_raw: classico,
        atualizado_em: agora()
      });
      t.update(ref, campos);
      return { ...atual, ...campos };
    });
  }

  // ── POST /api/point/cobrar ───────────────────────────────────────────
  async function cobrar(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "POST") throw erroHttp(405, "Método não permitido.");
      const staff = await exigirStaff(tokenDaRequisicao(req));
      const dados = validarCobranca(corpoJson(req));

      const terminalId = String(env.MP_POINT_TERMINAL_ID || "").trim();
      if (!terminalId) throw erroHttp(500, "Maquininha não configurada no servidor (falta MP_POINT_TERMINAL_ID).");

      const db = getDb();
      await limitar(db, `point-cobrar:${staff.uid}`, {
        max: 20,
        janelaSegundos: 300,
        mensagem: "Muitas cobranças seguidas. Espere um pouco e tente de novo."
      });

      const ref = db.collection(COLECAO).doc(dados.cobrancaId);
      const existente = await ref.get();
      if (existente.exists) {
        const d = existente.data();
        if (!podeMexer(staff, d)) throw erroHttp(409, "Esta cobrança pertence a outra pessoa.");
        // Repetição da mesma chamada (resposta perdida, duplo clique): devolve
        // o que já existe, sem criar outra order.
        if (d.order_id) return res.status(200).json({ cobranca: projetarCobranca(d) });
        // Sem order_id = a tentativa anterior morreu antes do MP responder:
        // segue e tenta de novo (mesma chave de idempotência no MP).
      } else {
        await ref.set({
          cobranca_id: dados.cobrancaId,
          status: "criando",
          final: false,
          aprovado: false,
          tipo: dados.tipo,
          valor: dados.valor,
          parcelas_solicitadas: dados.parcelas,
          quem_paga_juros: dados.quemPagaJuros,
          terminal_id: terminalId,
          vendedor_uid: staff.uid,
          vendedor_nome: staff.nome,
          criado_em: agora(),
          atualizado_em: agora()
        });
      }

      let order;
      try {
        const corpoOrder = montarOrderPoint({
          ...dados,
          terminalId,
          descricao: `Venda Amira ${dados.cobrancaId}`,
          expiraMin: env.POINT_EXPIRA_MIN
        });
        try {
          order = await mp.criarOrderPoint(corpoOrder, dados.cobrancaId);
        } catch (erro) {
          // O MP às vezes só aceita o outro nome do campo "quem paga o juros"
          // (a doc usa os dois): tenta o alternativo UMA vez, com chave nova
          // porque o corpo mudou.
          const alternativo = trocarCampoQuemPagaJuros(corpoOrder, erro);
          if (!alternativo) throw erro;
          console.warn("[point] o MP recusou o campo de quem paga o juros; tentando o nome alternativo:", erro.message);
          order = await mp.criarOrderPoint(alternativo, `${dados.cobrancaId}-b`);
        }
      } catch (erro) {
        await ref.update({ status: "erro", erro: String(erro.message).slice(0, 300), atualizado_em: agora() }).catch(() => {});
        // 409 do MP = a maquininha já tem uma cobrança aberta (só cabe uma).
        if (erro && erro.mpStatus === 409) {
          throw erroHttp(409, "A maquininha já tem uma cobrança pendente. Conclua ou cancele por lá e tente de novo.");
        }
        throw erro;
      }

      const norm = normalizarOrder(order);
      await ref.update(compactar({ ...norm, mp_raw: order, atualizado_em: agora() }));
      const atualizado = (await ref.get()).data();
      return res.status(200).json({ cobranca: projetarCobranca(atualizado) });
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── GET /api/point/status?cobrancaId= ────────────────────────────────
  async function status(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "GET") throw erroHttp(405, "Método não permitido.");
      const staff = await exigirStaff(tokenDaRequisicao(req));
      const db = getDb();
      const { ref, d } = await carregar(db, idDaQuery(req), staff);

      // Já terminou (ou nem chegou no MP): nada a perguntar lá.
      if (d.final || !d.order_id) return res.status(200).json({ cobranca: projetarCobranca(d) });

      try {
        const order = await mp.buscarOrderPoint(d.order_id);
        const novo = (await sincronizar(db, ref, order, d)) || d;
        return res.status(200).json({ cobranca: projetarCobranca(novo) });
      } catch (erro) {
        // MP fora do ar / instável: devolve o último estado conhecido e o
        // PDV continua perguntando — não é motivo pra mostrar erro.
        console.warn("[point] status: falha ao atualizar no MP:", erro && erro.message);
        return res.status(200).json({ cobranca: projetarCobranca({ ...d, aviso: "Sem resposta do Mercado Pago agora. Tentando de novo…" }) });
      }
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── POST /api/point/cancelar ─────────────────────────────────────────
  async function cancelar(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "POST") throw erroHttp(405, "Método não permitido.");
      const staff = await exigirStaff(tokenDaRequisicao(req));
      const db = getDb();
      const { ref, d } = await carregar(db, idDaQuery(req), staff);

      if (d.final) return res.status(200).json({ cobranca: projetarCobranca(d) });

      // Nunca chegou no MP (falhou antes): é só encerrar o registro.
      if (!d.order_id) {
        await ref.update({ status: "canceled", status_detail: "canceled_by_api", final: true, aprovado: false, atualizado_em: agora() });
        return res.status(200).json({ cobranca: projetarCobranca((await ref.get()).data()) });
      }

      try {
        await mp.cancelarOrderPoint(d.order_id, `cancel-${d.cobranca_id}`);
      } catch (erro) {
        console.warn("[point] cancelar recusado pelo MP:", erro && erro.message);
        throw erroHttp(
          409,
          "Não deu pra cancelar pelo sistema — se a cobrança já está aberta na maquininha, cancele por lá (botão de cancelar/voltar) e aguarde aqui."
        );
      }
      // Estado canônico depois do cancelamento (a resposta do cancel pode vir enxuta).
      const order = await mp.buscarOrderPoint(d.order_id);
      const novo = (await sincronizar(db, ref, order, d)) || d;
      return res.status(200).json({ cobranca: projetarCobranca(novo) });
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── POST /api/point/estornar (só admin) ──────────────────────────────
  async function estornar(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "POST") throw erroHttp(405, "Método não permitido.");
      const staff = await exigirAdmin(tokenDaRequisicao(req));
      const db = getDb();
      const { ref, d } = await carregar(db, idDaQuery(req), null);

      if (d.status === "refunded") return res.status(200).json({ cobranca: projetarCobranca(d) });
      if (!d.order_id || d.status !== "processed") {
        throw erroHttp(409, "Só dá pra estornar uma cobrança aprovada.");
      }

      const resposta = await mp.estornarOrderPoint(d.order_id, `refund-${d.cobranca_id}`);
      // O estorno é sempre total. Gravamos direto: o MP já confirmou na resposta.
      await ref.update(
        compactar({
          status: "refunded",
          final: true,
          aprovado: false,
          estornado_em: agora(),
          estornado_por_uid: staff.uid,
          mp_estorno: resposta && Object.keys(resposta).length ? resposta : null,
          atualizado_em: agora()
        })
      );
      return res.status(200).json({ cobranca: projetarCobranca((await ref.get()).data()) });
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── GET|POST /api/point/terminais (só admin) ─────────────────────────
  // GET lista os terminais da conta (pra achar o MP_POINT_TERMINAL_ID e
  // conferir o modo). POST troca o modo: PDV (recebe do sistema) ou
  // STANDALONE (maquininha autônoma — o "plano B" se o sistema cair).
  async function terminais(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      await exigirAdmin(tokenDaRequisicao(req));
      const configurado = String(env.MP_POINT_TERMINAL_ID || "").trim();

      if (req.method === "GET") {
        const resposta = await mp.listarTerminais();
        return res.status(200).json({
          configurado: configurado || null,
          terminais: mapearTerminais(resposta, configurado)
        });
      }

      if (req.method === "POST") {
        const { terminalId, modo } = corpoJson(req);
        if (!terminalId || typeof terminalId !== "string") throw erroHttp(400, "Informe o terminal.");
        if (!["PDV", "STANDALONE"].includes(modo)) throw erroHttp(400, "Modo inválido (PDV ou STANDALONE).");
        await mp.definirModoTerminal(terminalId, modo);
        return res.status(200).json({ ok: true, terminalId, modo });
      }

      throw erroHttp(405, "Método não permitido.");
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── GET /api/point/diagnostico (só admin) ────────────────────────────
  // Confere token, Firebase, terminais e modo PDV e diz o que falta (ver
  // point-diagnostico.js). Devolve 200 mesmo com itens em "erro": o
  // resultado É o diagnóstico. Só falha (401/403) se o login não passar.
  async function diagnostico(req, res) {
    if (aplicarCors(req, res, env)) return;
    try {
      if (req.method !== "GET") throw erroHttp(405, "Método não permitido.");
      await exigirAdmin(tokenDaRequisicao(req));
      const resultado = await diagnosticar({ env, mp, checarFirebase });
      return res.status(200).json(resultado);
    } catch (erro) {
      return responderErro(res, erro);
    }
  }

  // ── POST /api/webhook-point (chamado pelo Mercado Pago) ──────────────
  // Tópico "orders". A notificação só serve de gatilho: buscamos a order de
  // verdade no MP (nunca confiamos no corpo) e aplicamos no documento. Rede
  // de segurança pra cobrança aprovada que o PDV não está mais acompanhando.
  async function webhook(req, res) {
    if (req.method !== "POST" && req.method !== "GET") return res.status(405).end();
    try {
      const orderId =
        (req.query && (req.query["data.id"] || req.query.id)) ||
        (req.body && req.body.data && req.body.data.id) ||
        null;

      const assinatura = checarAssinatura(req, orderId || "", env);
      if (assinatura === "sem-segredo") {
        console.warn("[point/webhook] MP_WEBHOOK_SECRET não configurada — notificação aceita SEM validar assinatura.");
      } else if (assinatura !== "ok") {
        console.warn(`[point/webhook] assinatura recusada: ${assinatura}`);
        return res.status(401).json({ erro: "Assinatura inválida" });
      }

      // Só interessa order (ids "ORD..."); qualquer outra notificação é ignorada.
      if (!orderId || !/^ORD/i.test(String(orderId))) return res.status(200).end();

      const order = await mp.buscarOrderPoint(orderId);
      const idDoc = order && order.external_reference;
      if (!idDoc || !ID_COBRANCA.test(String(idDoc))) return res.status(200).end(); // não é do sistema

      const db = getDb();
      const ref = db.collection(COLECAO).doc(String(idDoc));
      const snap = await ref.get();
      if (!snap.exists) return res.status(200).end();

      await sincronizar(db, ref, order, snap.data());
      return res.status(200).json({ ok: true });
    } catch (erro) {
      // 500 de propósito: o MP tenta de novo mais tarde (o webhook é a rede
      // de segurança de quem parou de acompanhar a cobrança).
      console.error("[point/webhook]", erro && erro.message);
      return res.status(500).json({ erro: "Falha ao processar a notificação." });
    }
  }

  return { cobrar, status, cancelar, estornar, terminais, diagnostico, webhook };
}

module.exports = { criarHandlers, checarAssinatura, COLECAO };
