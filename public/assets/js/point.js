// ── Maquininha Mercado Pago Point — cliente da API e regras do PDV ─────
// Módulo PURO (nenhum import de Firebase/DOM): recebe por parâmetro o
// fetch e a função que entrega o ID token, então roda igual no navegador e
// nos testes (tests/point-client.test.mjs). A tela fica em point-ui.js.
//
// A API (api/point/*) mora na Vercel — ver README, seção "Maquininha".

/** forma de pagamento do PDV → tipo do Mercado Pago (crediário/dinheiro/pix não passam pela maquininha) */
export const TIPO_POINT = { credito: "credit_card", debito: "debit_card" };

export const STATUS_FINAIS = ["processed", "failed", "canceled", "expired", "refunded"];

/** Id único da tentativa de cobrança (vira external_reference no MP: só [A-Za-z0-9_-], até 64). */
export function novoCobrancaId() {
  const uuid = globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `pdv-${uuid}`;
}

/**
 * @param {{apiBase?:string, obterToken:()=>Promise<string>, fetchImpl?:typeof fetch}} o
 *   apiBase: URL da API sem barra final ("" = mesma origem do front).
 */
export function criarClientePoint({ apiBase = "", obterToken, fetchImpl }) {
  const base = String(apiBase || "").replace(/\/+$/, "");

  async function chamar(caminho, { metodo = "GET", corpo } = {}) {
    const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
    const token = await obterToken();
    let resp;
    try {
      resp = await doFetch(`${base}${caminho}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined
      });
    } catch (_) {
      const e = new Error("Sem conexão com o servidor da maquininha.");
      e.rede = true;
      throw e;
    }
    const dados = await resp.json().catch(() => null);
    if (!resp.ok) {
      const e = new Error((dados && dados.erro) || `Erro ${resp.status} no servidor da maquininha.`);
      e.status = resp.status;
      // "definitivo" = a NOSSA API respondeu com um erro explícito, então a
      // cobrança com certeza não foi criada. Erro de rede ou de gateway
      // (sem JSON nosso) é ambíguo: a order pode existir na maquininha.
      e.definitivo = Boolean(dados && dados.erro);
      throw e;
    }
    return dados || {};
  }

  return {
    cobrar: (p) => chamar("/api/point/cobrar", { metodo: "POST", corpo: p }),
    status: (id) => chamar(`/api/point/status?cobrancaId=${encodeURIComponent(id)}`),
    cancelar: (id) => chamar("/api/point/cancelar", { metodo: "POST", corpo: { cobrancaId: id } }),
    estornar: (id) => chamar("/api/point/estornar", { metodo: "POST", corpo: { cobrancaId: id } }),
    terminais: () => chamar("/api/point/terminais"),
    definirModo: (terminalId, modo) => chamar("/api/point/terminais", { metodo: "POST", corpo: { terminalId, modo } }),
    // Checklist do que falta pra cobrar (token, Firebase, terminal, modo PDV) — só admin.
    diagnostico: () => chamar("/api/point/diagnostico")
  };
}

// ── Teste local (só neste navegador) ────────────────────────────────────
// Liga a maquininha SÓ neste computador, apontando pra API que roda nele
// (npm run api:dev), sem mexer na configuração do sistema — que vale pra
// todo mundo e é gravada no Firestore. Fica no localStorage deste navegador.
export const CHAVE_TESTE_LOCAL = "amira.point.local";

/**
 * Só aceita a API no PRÓPRIO computador (localhost / 127.0.0.1): o ID token
 * de quem está logado vai junto em toda chamada, então esse atalho nunca
 * pode apontar pra outro servidor. Devolve a URL limpa ou "".
 */
export function urlLocalValida(url) {
  const s = String(url ?? "").trim().replace(/\/+$/, "");
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(s) ? s : "";
}

/** localStorage, ou null se o navegador bloqueou (janela anônima, dados do site desligados). */
export function storageSeguro() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

/** O teste local deste navegador ({ api_url }) ou null se está desligado/inválido. */
export function lerTesteLocal(storage) {
  try {
    const bruto = storage && storage.getItem(CHAVE_TESTE_LOCAL);
    if (!bruto) return null;
    const dados = JSON.parse(bruto);
    const url = urlLocalValida(dados && dados.api_url);
    return dados && dados.ativo === true && url ? { api_url: url } : null;
  } catch (_) {
    return null;
  }
}

/** Liga o teste local neste navegador. @returns {{ok:true, api_url:string}|{ok:false, erro:string}} */
export function ativarTesteLocal(storage, apiUrl) {
  const url = urlLocalValida(apiUrl);
  if (!url) {
    return { ok: false, erro: "A URL precisa ser deste computador, tipo http://localhost:3001 — o teste local só fala com a própria máquina." };
  }
  try {
    storage.setItem(CHAVE_TESTE_LOCAL, JSON.stringify({ ativo: true, api_url: url }));
    return { ok: true, api_url: url };
  } catch (_) {
    return { ok: false, erro: "Este navegador não deixou guardar o teste local (janela anônima ou dados do site bloqueados)." };
  }
}

/** Desliga o teste local. Devolve se conseguiu. */
export function desativarTesteLocal(storage) {
  try {
    if (storage) storage.removeItem(CHAVE_TESTE_LOCAL);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * A configuração da maquininha que vale NESTE navegador: a do sistema
 * (Configurações → Maquininha) ou, com o teste local ligado, a API local —
 * sempre NÃO obrigatória, pra um teste nunca travar a venda.
 * @returns {{ativo:boolean, obrigatorio:boolean, api_url:string, testeLocal:boolean}}
 */
export function configPointEfetiva(config, storage) {
  const local = lerTesteLocal(storage);
  if (local) return { ativo: true, obrigatorio: false, api_url: local.api_url, testeLocal: true };
  return {
    ativo: Boolean(config && config.ativo === true),
    obrigatorio: Boolean(config && config.obrigatorio === true),
    api_url: String((config && config.api_url) || "").trim().replace(/\/+$/, ""),
    testeLocal: false
  };
}

/**
 * Cria a cobrança. Distingue falha DEFINITIVA (nada foi criado) de resposta
 * PERDIDA (não dá pra saber): nesse caso o PDV segue consultando o status
 * pelo mesmo id — 404 lá quer dizer "nunca foi criada".
 * @returns {Promise<{estado:"criada", cobranca:object}|{estado:"falhou"|"incerta", erro:Error}>}
 */
export async function iniciarCobranca(cliente, params) {
  try {
    const { cobranca } = await cliente.cobrar(params);
    return { estado: "criada", cobranca };
  } catch (erro) {
    return { estado: erro && erro.definitivo ? "falhou" : "incerta", erro };
  }
}

/** Quem paga o juros do parcelamento na maquininha, seguindo a tabela já configurada. */
export function quemPagaJuros({ tipo, parcelas, taxas }) {
  return tipo === "credit_card" && parcelas > 1 && Number(taxas && taxas.cliente) > 0 ? "buyer" : "seller";
}

/** status do MP → resultado que o PDV entende (null = ainda em andamento). */
export function resultadoDe(cobranca) {
  return (
    { processed: "aprovada", failed: "recusada", canceled: "cancelada", expired: "expirada", refunded: "estornada" }[
      cobranca && cobranca.status
    ] || null
  );
}

/** Texto do que está acontecendo, pra mostrar enquanto espera. */
export function textoStatus(cobranca) {
  const s = cobranca && cobranca.status;
  if (s === "at_terminal") return "Cobrança na maquininha. Peça pro cliente passar ou aproximar o cartão.";
  if (s === "action_required") return "A maquininha está pedindo uma ação — confira o visor.";
  if (s === "processed") return "Pagamento aprovado.";
  if (s === "failed") return "Pagamento recusado.";
  if (s === "canceled") return "Cobrança cancelada.";
  if (s === "expired") return "Tempo esgotado sem pagamento.";
  if (s === "sem_conexao") return "Sem conexão com o servidor. Tentando de novo…";
  return "Enviando para a maquininha…";
}

const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consulta o status até a cobrança terminar. Devolve
 *   { resultado: "aprovada"|"recusada"|"cancelada"|"expirada"|"estornada", cobranca }
 *   { resultado: "pendente" }   — quem chamou mandou parar, ou estourou o tempo (a cobrança pode seguir viva)
 *   { resultado: "inexistente" } — a API não conhece esse id (a criação não aconteceu)
 * Lança em 401/403 (sessão/permissão — insistir não adianta).
 * Falha de rede não interrompe: mostra "sem conexão" e tenta de novo.
 */
export async function aguardarCobranca(
  cliente,
  cobrancaId,
  { onEstado = () => {}, intervaloMs = 2500, timeoutMs = 20 * 60 * 1000, parar = () => false, dormir = dormirPadrao, agora = Date.now } = {}
) {
  const inicio = agora();
  let falhasSeguidas = 0;

  // dorme em fatias pequenas pra reagir rápido quando o modal é fechado
  async function esperar(ms) {
    let resta = ms;
    while (resta > 0 && !parar()) {
      const fatia = Math.min(250, resta);
      await dormir(fatia);
      resta -= fatia;
    }
  }

  for (;;) {
    if (parar()) return { resultado: "pendente" };

    let cobranca = null;
    try {
      ({ cobranca } = await cliente.status(cobrancaId));
      falhasSeguidas = 0;
    } catch (e) {
      if (e && e.status === 404) return { resultado: "inexistente" };
      if (e && (e.status === 401 || e.status === 403)) throw e;
      falhasSeguidas += 1;
      onEstado({ status: "sem_conexao", aviso: "Sem conexão com o servidor. Tentando de novo…" });
    }

    if (cobranca) {
      onEstado(cobranca);
      const r = resultadoDe(cobranca);
      if (r) return { resultado: r, cobranca };
    }

    if (agora() - inicio > timeoutMs) return { resultado: "pendente", cobranca: cobranca || undefined };
    // recua um pouco quando o servidor está instável (até 4x o intervalo)
    await esperar(intervaloMs * (1 + Math.min(3, falhasSeguidas)));
  }
}

/**
 * Monta o item de `pagamentos[]` da venda pra um pagamento feito NA
 * MAQUININHA, com os números reais que ela informou. O que a maquininha não
 * informou (custo da loja, valor cobrado) cai na estimativa pela tabela de
 * juros — `origem_taxa` diz de onde veio o custo ("maquininha"/"estimada").
 * `valor` continua sendo o valor de tabela (antes de qualquer juros): é a
 * base de comissão/relatórios e nunca muda.
 *
 * @param {{forma:string, valor:number, parcelas?:number, point:object}} p linha do PDV já aprovada
 * @param {{valorComJuros:number, custoLoja:number}} estimativa da tabela de juros (mesmas parcelas)
 * @param {boolean} parcelavel a forma parcela (credito/crediario)?
 */
export function pagamentoDaMaquininha(p, estimativa, parcelavel) {
  const arred = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const pt = p.point;
  const valor = arred(p.valor);
  const parcelas = parcelavel ? Math.max(1, Math.trunc(pt.parcelas ?? p.parcelas) || 1) : 1;

  const valorPago = arred(pt.valor_pago ?? estimativa.valorComJuros);
  const custoLoja = arred(pt.custo_loja ?? estimativa.custoLoja);
  const jurosPct = valor > 0 ? Math.max(0, arred(((valorPago - valor) / valor) * 100)) : 0;
  const pctLoja = valor > 0 ? arred((custoLoja / valor) * 100) : 0;

  return {
    forma: p.forma,
    valor,
    ...(parcelavel && parcelas > 1 ? { parcelas, valor_parcela: arred(valorPago / parcelas) } : {}),
    juros_pct: jurosPct,
    pct_loja: pctLoja,
    valor_com_juros: valorPago,
    custo_loja: custoLoja,
    valor_liquido: arred(valor - custoLoja),
    origem_taxa: pt.custo_loja !== undefined && pt.custo_loja !== null ? "maquininha" : "estimada",
    point: {
      cobranca_id: pt.cobrancaId,
      order_id: pt.order_id ?? null,
      payment_id: pt.payment_id ?? null,
      bandeira: pt.bandeira ?? null,
      tipo: TIPO_POINT[p.forma] ?? null,
      status: "processed"
    }
  };
}

/** Guarda no item do PDV o que a cobrança aprovada informou (ver pagamentoDaMaquininha). */
export function marcarAprovada(pg, cobranca) {
  pg.point = {
    cobrancaId: cobranca.cobranca_id,
    status: "processed",
    order_id: cobranca.order_id,
    payment_id: cobranca.payment_id,
    bandeira: cobranca.bandeira,
    parcelas: cobranca.parcelas,
    valor_pago: cobranca.valor_pago,
    custo_loja: cobranca.custo_loja,
    liquido_mp: cobranca.liquido_mp
  };
  // O cliente pode ter trocado as parcelas na maquininha: vale o que ela reportou.
  if (cobranca.parcelas) pg.parcelas = cobranca.parcelas;
}
