import { modal, toast, escapeHtml } from "./ui.js";
import { iniciarCobranca, aguardarCobranca, textoStatus } from "./point.js";

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

const ROTULO_FINAL = { recusada: "Pagamento recusado.", cancelada: "Cobrança cancelada.", expirada: "Tempo esgotado sem pagamento." };

export function cobrarNaMaquininha({ cliente, cobrancaId, params, resumo, jaCriada = false }) {
  return new Promise((resolve) => {
    let fechado = false; // a pessoa fechou o modal (botão Fechar ou clique fora)
    let aoFechar = () => {};

    const corpo = document.createElement("div");
    corpo.className = "pt-box";
    corpo.innerHTML = `
      <div class="pt-valor">${escapeHtml(resumo || "")}</div>
      <div class="pt-spin" id="pt-spin" aria-hidden="true"></div>
      <p class="pt-status" id="pt-status" role="status" aria-live="polite">${escapeHtml(textoStatus(null))}</p>
      <p class="muted" id="pt-aviso"></p>`;

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
          toast(e && e.message ? e.message : "Não foi possível cancelar.", "err");
        }
        return false;
      }
    });

    const fechar = () => {
      fechado = true;
      aoFechar();
    };
    bg.querySelector(".btn.ghost").addEventListener("click", fechar);
    bg.addEventListener("click", (e) => {
      if (e.target === bg) fechar();
    });

    const statusEl = corpo.querySelector("#pt-status");
    const avisoEl = corpo.querySelector("#pt-aviso");
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
          const detalhe = r.cobranca && r.cobranca.status_detail;
          avisoEl.textContent = detalhe && detalhe !== r.cobranca.status ? `Detalhe: ${detalhe}` : "";
          const confirma = bg.querySelector(".actions .btn:not(.ghost)");
          if (confirma) confirma.style.display = "none";
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
