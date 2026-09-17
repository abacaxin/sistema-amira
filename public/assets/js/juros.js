import { round2 } from "./money.js";

// ── Juros de parcelamento — helpers compartilhados (PDV/Config/Caixa/Painel) ─
// Cada forma de pagamento (credito, crediario, debito) tem sua PROPRIA
// tabela de juros por quantidade de parcelas, configurada em
// configuracoes/sistema.parcelamento.juros.{forma}. Cada entrada guarda DOIS
// percentuais independentes — nao e "cliente OU loja paga", os dois existem
// ao mesmo tempo:
//   cliente = somado ao que o cliente paga (parcelar fica mais caro pra ele)
//   loja    = custo da loja (ex.: taxa da maquininha/financiamento),
//             aplicado sobre o valor ORIGINAL (antes do juros do cliente) —
//             reduz o quanto a loja recebe de fato.
// Exemplo: produto R$100, taxa "5|2" -> cliente paga R$105, custo da loja e
// 2% de R$100 = R$2, loja recebe liquido R$103.
//
// Debito nunca parcela de verdade, mas pode ter uma taxa em "1" (taxa do
// debito a vista) — por isso a busca de taxa usa sempre `parcelas || 1`,
// nao so quando a forma e parcelavel.

export const FORMAS_JUROS = ["credito", "crediario", "debito"];
export const FORMAS_PARCELAVEIS = new Set(["credito", "crediario"]);

/** Quantas parcelas cabem num valor (respeita o maximo e o valor minimo por parcela). */
export function parcelasDisponiveis(valor, parc) {
  const max = Math.max(1, Math.trunc(parc?.maximo) || 12);
  const min = Math.max(0, Number(parc?.minimo_parcela) || 0);
  const porMinimo = min > 0 ? Math.max(1, Math.floor(valor / min)) : max;
  const limite = Math.max(1, Math.min(max, porMinimo));
  return Array.from({ length: limite }, (_, i) => i + 1);
}

/** Taxas {cliente, loja} configuradas pra essa forma + quantidade de parcelas. */
export function taxasDe(config, forma, parcelas) {
  const tabela = config?.parcelamento?.juros?.[forma] || {};
  return tabela[String(parcelas)] || { cliente: 0, loja: 0 };
}

/**
 * Calculo completo de um pagamento a partir do valor ORIGINAL (de tabela,
 * antes de qualquer juros) e das taxas {cliente, loja} dessa forma+parcelas.
 *
 * `valorLiquido` desconta o custo da loja do valor ORIGINAL, NAO do valor
 * com juros do cliente — o juros cobrado do cliente e tratado como uma
 * referencia informativa a parte (valorComJuros/total_com_juros), que nunca
 * entra no "liquido". Ou seja, o juros do cliente nao compensa o custo da
 * maquininha no liquido — os dois sao numeros independentes.
 * @returns {{pctCliente, pctLoja, valorComJuros, custoLoja, valorLiquido, valorParcela}}
 */
export function infoParcela(valorOriginal, parcelas, taxas) {
  const pctCliente = Number(taxas?.cliente || 0);
  const pctLoja = Number(taxas?.loja || 0);
  const valorComJuros = round2(valorOriginal * (1 + pctCliente / 100));
  const custoLoja = round2(valorOriginal * (pctLoja / 100));
  const valorLiquido = round2(valorOriginal - custoLoja);
  const valorParcela = round2(valorComJuros / Math.max(1, Math.trunc(parcelas) || 1));
  return { pctCliente, pctLoja, valorComJuros, custoLoja, valorLiquido, valorParcela };
}
