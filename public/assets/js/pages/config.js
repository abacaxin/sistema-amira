import { requireAuth } from "../auth.js";
import { initShell, toast, escapeHtml } from "../ui.js";
import { db, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "../db.js";
import { parseNum } from "../money.js";
import { FORMAS_JUROS, parseTabelaJuros, formatarTabelaJuros } from "../juros.js";

const BASES = ["total", "total_sem_desconto", "margem"];
const FORMA_LABEL = { credito: "Crédito", crediario: "Crediário", debito: "Débito" };

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "config" });

const [snapSis, snapInd] = await Promise.all([
  getDoc(doc(db, "configuracoes", "sistema")),
  getDoc(doc(db, "configuracoes", "indicadores")),
]);
const cfg = snapSis.exists() ? snapSis.data() : {};
const com = cfg.comissao || {};
const parc = cfg.parcelamento || {};
const ind = snapInd.exists() ? snapInd.data() : {};

root.innerHTML = `
  <div class="card">
    <strong>Configuracoes do sistema interno</strong>
    <p class="muted">O catalogo, os precos e o estoque sao os do site (mesma base). Aqui ficam so os ajustes internos.</p>
    <label>Nome da loja (recibo)</label>
    <input id="nome" value="${escapeHtml(cfg.nome_loja ?? "Amira")}">
    <label>CNPJ</label>
    <input id="cnpj" value="${escapeHtml(cfg.cnpj ?? "")}">
    <label>Formas de pagamento do PDV (separadas por virgula)</label>
    <input id="formas" value="${escapeHtml((cfg.formas_pagamento ?? ["dinheiro", "pix", "debito", "credito"]).join(", "))}">
    <div class="row">
      <div>
        <label>Base padrao da comissao (vendedor)</label>
        <select id="base">
          ${BASES.map((b) => `<option ${b === (com.base || "total") ? "selected" : ""}>${b}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Percentual padrao (%)</label>
        <input id="pct" value="${com.percentual_padrao ?? 0}">
      </div>
    </div>
    <p class="muted">Base "total" = sobre o valor final pago. "total_sem_desconto" = sobre os itens a preco cheio. "margem" = (venda - custo); o catalogo do site nao guarda custo, entao "margem" fica em 0 ate existir esse campo.</p>
    <button class="btn" id="salvar" style="margin-top:8px">Salvar</button>
  </div>

  <div class="card">
    <strong>Parcelamento e juros do PDV</strong>
    <p class="muted">Ao escolher "credito" ou "crediario" no pagamento do PDV, o vendedor pode parcelar (debito nunca parcela). Aqui voce define ate quantas vezes, o valor minimo de cada parcela, e os juros de cada forma.</p>
    <div class="row">
      <div><label>Maximo de parcelas</label><input id="parc-max" value="${parc.maximo ?? 12}"></div>
      <div><label>Valor minimo por parcela (R$)</label><input id="parc-min" value="${parc.minimo_parcela ?? 0}"></div>
    </div>
    <p class="muted">Cada entrada e <code>parcelas:jurosCliente|custoLoja</code>, separadas por virgula. <code>jurosCliente</code> e somado ao valor que o cliente paga nessa forma; <code>custoLoja</code> e o custo da loja (ex.: taxa da maquininha) sobre o valor original — os dois sao independentes, nao precisam ser iguais, e o <code>|custoLoja</code> e opcional (fica 0 se omitido). Quantidade nao listada = sem juros nem custo. Debito nunca parcela — use so a entrada <code>1:...</code> pra registrar a taxa do debito a vista.</p>
    ${FORMAS_JUROS.map(
      (forma) => `
      <label>Juros no ${FORMA_LABEL[forma]}</label>
      <input id="juros-${forma}" value="${escapeHtml(formatarTabelaJuros(parc.juros?.[forma]))}" placeholder="${forma === "debito" ? "ex.: 1:0|1.5" : "ex.: 1:0|3, 3:5|2, 6:12|4"}">`
    ).join("")}
    <button class="btn" id="salvar-parc" style="margin-top:8px">Salvar parcelamento</button>
  </div>

  <div class="card">
    <strong>Comissao de indicadores (link ?ref= no site)</strong>
    <p class="muted">Compra feita pelo link de um indicador gera comissao sobre o total dos itens elegiveis. Pagamento e manual. O link do indicador nao tem prazo de validade.</p>
    <label>URL do site (para montar o link)</label>
    <input id="ind-site" value="${escapeHtml(ind.site_url ?? "")}" placeholder="https://flora-5754a.web.app">
    <label>Percentual (%)</label>
    <input id="ind-pct" value="${ind.percentual ?? 5}">
    <label>Slugs de categoria que NAO geram comissao (separados por virgula)</label>
    <input id="ind-cat" value="${escapeHtml((ind.categorias_excluidas ?? ["iphones"]).join(", "))}">
    <p class="muted">No site, iPhone e a opcao da camada principal cujo slug comeca com <code>iphone</code>. O prefixo "iphone" ja e reconhecido automaticamente; liste aqui outros slugs a excluir, se houver.</p>
    <button class="btn" id="salvar-ind" style="margin-top:8px">Salvar indicadores</button>
  </div>`;

document.getElementById("salvar").onclick = async () => {
  await setDoc(
    doc(db, "configuracoes", "sistema"),
    {
      nome_loja: document.getElementById("nome").value.trim(),
      cnpj: document.getElementById("cnpj").value.trim(),
      formas_pagamento: document
        .getElementById("formas")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      comissao: {
        base: document.getElementById("base").value,
        percentual_padrao: parseNum(document.getElementById("pct").value),
      },
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
  toast("Configuracoes salvas.", "ok");
};

document.getElementById("salvar-parc").onclick = async () => {
  // updateDoc com caminhos pontilhados (nao setDoc({merge:true})): merge do
  // Firestore em mapa aninhado e RECURSIVO — ele so sobrescreveria as chaves
  // novas, e uma parcela apagada do texto continuaria existindo no banco.
  // Caminho pontilhado substitui o mapa daquela forma por inteiro.
  const dados = {
    "parcelamento.maximo": Math.max(1, Math.trunc(parseNum(document.getElementById("parc-max").value)) || 12),
    "parcelamento.minimo_parcela": Math.max(0, parseNum(document.getElementById("parc-min").value)),
    atualizadoEm: serverTimestamp(),
  };
  for (const forma of FORMAS_JUROS) {
    dados[`parcelamento.juros.${forma}`] = parseTabelaJuros(document.getElementById(`juros-${forma}`).value);
  }

  try {
    await updateDoc(doc(db, "configuracoes", "sistema"), dados);
  } catch (_) {
    // Doc "sistema" pode nao existir ainda (primeira configuracao) —
    // updateDoc falha em doc inexistente; cria com setDoc nesse caso.
    await setDoc(
      doc(db, "configuracoes", "sistema"),
      {
        parcelamento: {
          maximo: dados["parcelamento.maximo"],
          minimo_parcela: dados["parcelamento.minimo_parcela"],
          juros: Object.fromEntries(FORMAS_JUROS.map((f) => [f, dados[`parcelamento.juros.${f}`]])),
        },
        atualizadoEm: serverTimestamp(),
      },
      { merge: true }
    );
  }
  toast("Parcelamento salvo.", "ok");
};

document.getElementById("salvar-ind").onclick = async () => {
  await setDoc(
    doc(db, "configuracoes", "indicadores"),
    {
      site_url: document.getElementById("ind-site").value.trim().replace(/\/+$/, ""),
      percentual: parseNum(document.getElementById("ind-pct").value),
      categorias_excluidas: document
        .getElementById("ind-cat")
        .value.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
  toast("Configuracoes de indicadores salvas.", "ok");
};
