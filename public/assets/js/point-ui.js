import { modal, toast, escapeHtml } from "./ui.js";
import { iniciarCobranca, aguardarCobranca, textoStatus, detalheLegivel } from "./point.js";

// ── Modal de cobrança na maquininha ────────────────────────────────────
// Abre um modal, cria a cobrança (ou só acompanha uma que já existe) e fica
// consultando o status até terminar. Não conhece PDV: quem chama decide o
// que fazer com o resultado.
//
// Devolve uma Promise que resolve com um destes:
//   { resultado: "aprovada", cobranca }
//   { resultado: "recusada" | "cancelada" | "expirada", cobranca }
//        (o modal fica aberto mostrando o motivo até a pessoa fechar)
//   { resultado: "pendente" }     modal fechado com a cobrança ainda viva —
//                                 ela continua na maquininha (o PDV guarda o
//                                 id e deixa "Acompanhar" na linha)
//   { resultado: "inexistente" }  a cobrança nunca chegou a ser criada
//   { resultado: "falhou", erro } não conseguiu nem criar (validação, 409...)
//                                 ou perdeu a sessão
//
// Cancelar: o Mercado Pago só cancela PELA API uma cobrança que ainda não
// chegou na maquininha (o que dura poucos segundos). Depois disso só dá pra
// cancelar na própria maquininha (botão X) — e aí o acompanhamento abaixo
// percebe sozinho que ficou "cancelada". O botão "Cancelar cobrança" tenta
// pela API e, se o MP recusar por isso, explica em vez de só dar erro.

const ROTULO_FINAL = { recusada: "Pagamento recusado.", cancelada: "Cobrança cancelada.", expirada: "Tempo esgotado sem pagamento." };

// `resumo` é o texto grande do topo. Aceita uma string (só o texto) ou um objeto
// { rotulo, total, estimado, detalhe }: o TOTAL cobrado do cliente em destaque,
// com um rótulo em cima e o detalhe (parcelas, valor original, juros) embaixo.
export function cobrarNaMaquininha({ cliente, cobrancaId, params, resumo, jaCriada = false }) {
  return new Promise((resolve) => {
    let fechado = false; // a pessoa fechou o modal (botão Fechar ou clique fora)
    let aoFechar = () => {};

    const r = typeof resumo === "string" || !resumo ? { total: resumo || "" } : resumo;
    const corpo = document.createElement("div");
    corpo.className = "pt-box";
    corpo.innerHTML = `
      ${r.rotulo ? `<div class="pt-rotulo">${escapeHtml(r.rotulo)}</div>` : ""}
      <div class="pt-valor">${escapeHtml(r.total || "")}${r.estimado ? ` <small class="pt-est">(estimado)</small>` : ""}</div>
      ${r.detalhe ? `<div class="pt-detalhe">${escapeHtml(r.detalhe)}</div>` : ""}
      <div class="pt-spin" id="pt-spin" aria-hidden="true"></div>
      <p class="pt-status" id="pt-status" role="status" aria-live="polite">${escapeHtml(textoStatus(null))}</p>
      <p class="muted" id="pt-aviso"></p>
      <p class="pt-cancelar-msg" id="pt-cancelar-msg" role="alert" hidden></p>
      <p class="muted pt-dica" id="pt-dica">Desistiu? O botão “Cancelar cobrança” só funciona até a cobrança chegar na maquininha; depois disso, cancele por lá (botão X).</p>`;

    const statusEl = corpo.querySelector("#pt-status");
    const avisoEl = corpo.querySelector("#pt-aviso");
    const cancelarMsgEl = corpo.querySelector("#pt-cancelar-msg");
    const dicaEl = corpo.querySelector("#pt-dica");

    let botaoCancelar = null; // preenchido logo depois de criar o modal

    const bg = modal({
      titulo: "Cobrança na maquininha",
      corpo,
      textoConfirmar: "Cancelar cobrança",
      textoCancelar: "Fechar",
      // "Cancelar cobrança" pede o cancelamento e NÃO fecha: quem encerra a
      // tela é o próprio acompanhamento, quando o MP confirmar "cancelada".
      onConfirmar: async () => {
        try {
          await cliente.cancelar(cobrancaId);
          toast("Cancelando a cobrança…");
        } catch (e) {
          const msg = e && e.message ? e.message : "Não foi possível cancelar.";
          // Mensagem que FICA na tela (o toast some em segundos e o status abaixo é reescrito a cada consulta).
          cancelarMsgEl.textContent = msg;
          cancelarMsgEl.hidden = false;
          dicaEl.hidden = true;
          if (e && e.codigo === "na_maquininha") {
            // Não adianta insistir: o MP só cancela por lá. Esconde o botão (o modal reabilita, mas não mostra).
            if (botaoCancelar) botaoCancelar.style.display = "none";
          } else {
            toast(msg, "err");
          }
        }
        return false;
      }
    });

    botaoCancelar = bg.querySelector(".actions .btn:not(.ghost)");

    const fechar = () => {
      fechado = true;
      aoFechar();
    };
    bg.querySelector(".btn.ghost").addEventListener("click", fechar);
    bg.addEventListener("click", (e) => {
      if (e.target === bg) fechar();
    });

    const pintar = (cobranca) => {
      statusEl.textContent = textoStatus(cobranca);
      avisoEl.textContent = (cobranca && cobranca.aviso) || "";
    };

    (async () => {
      try {
        if (!jaCriada) {
          const ini = await iniciarCobranca(cliente, params);
          if (ini.estado === "falhou") {
            bg.remove();
            return resolve({ resultado: "falhou", erro: ini.erro });
          }
          if (ini.estado === "criada") pintar(ini.cobranca);
          // "incerta": a resposta se perdeu — segue consultando pelo mesmo id
          // (o servidor responde 404 se a cobrança nunca existiu).
        }

        const r = await aguardarCobranca(cliente, cobrancaId, { onEstado: pintar, parar: () => fechado });

        if (r.resultado === "recusada" || r.resultado === "cancelada" || r.resultado === "expirada") {
          // Mantém a mensagem na tela: a vendedora precisa VER que não passou.
          corpo.querySelector("#pt-spin").style.display = "none";
          statusEl.textContent = ROTULO_FINAL[r.resultado];
          statusEl.classList.add("pt-erro");
          avisoEl.textContent = detalheLegivel(r.cobranca);
          cancelarMsgEl.hidden = true;
          dicaEl.hidden = true;
          if (botaoCancelar) botaoCancelar.style.display = "none";
          if (!fechado && bg.isConnected) await new Promise((ok) => { aoFechar = ok; });
          return resolve(r);
        }

        bg.remove();
        return resolve(r);
      } catch (erro) {
        bg.remove();
        return resolve({ resultado: "falhou", erro });
      }
    })();
  });
}
