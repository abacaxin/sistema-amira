import { requireAuth } from "../auth.js";
import { initShell, toast, escapeHtml } from "../ui.js";
import { db, doc, getDoc, setDoc, serverTimestamp } from "../db.js";
import { parseNum } from "../money.js";

const BASES = ["total", "total_sem_desconto", "margem"];

const { perfil } = await requireAuth({ roles: ["admin"] });
const root = initShell({ perfil, active: "config" });

const [snapSis, snapInd] = await Promise.all([
  getDoc(doc(db, "configuracoes", "sistema")),
  getDoc(doc(db, "configuracoes", "indicadores")),
]);
const cfg = snapSis.exists() ? snapSis.data() : {};
const com = cfg.comissao || {};
const parc = cfg.parcelamento || {};
const jurosTxt = Object.entries(parc.juros || {})
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([n, p]) => `${n}:${p}`)
  .join(", ");
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
    <strong>Parcelamento do PDV (credito / crediario)</strong>
    <p class="muted">Ao escolher "credito" ou "crediario" no pagamento do PDV, o vendedor pode parcelar. Aqui voce define ate quantas vezes, o valor minimo de cada parcela e os juros de cada quantidade de parcelas.</p>
    <div class="row">
      <div><label>Maximo de parcelas</label><input id="parc-max" value="${parc.maximo ?? 12}"></div>
      <div><label>Valor minimo por parcela (R$)</label><input id="parc-min" value="${parc.minimo_parcela ?? 0}"></div>
    </div>
    <label>Juros por quantidade de parcelas (formato: parcelas:percentual, separado por virgula)</label>
    <input id="parc-juros" value="${escapeHtml(jurosTxt)}" placeholder="ex.: 2:0, 3:2.5, 4:4, 6:8">
    <p class="muted">Quantidade nao listada acima = 0% de juros. Ex.: "3:2.5" = parcelar em 3x cobra 2,5% de juros sobre o valor.</p>
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
  const juros = {};
  document
    .getElementById("parc-juros")
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((par) => {
      const [n, p] = par.split(":").map((s) => s.trim());
      const parcelas = Math.trunc(parseNum(n));
      if (parcelas > 1) juros[String(parcelas)] = parseNum(p);
    });

  await setDoc(
    doc(db, "configuracoes", "sistema"),
    {
      parcelamento: {
        maximo: Math.max(1, Math.trunc(parseNum(document.getElementById("parc-max").value)) || 12),
        minimo_parcela: Math.max(0, parseNum(document.getElementById("parc-min").value)),
        juros,
      },
      atualizadoEm: serverTimestamp(),
    },
    { merge: true }
  );
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
