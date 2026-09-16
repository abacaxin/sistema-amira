// Re-exporta toda a API do Firestore (doc, collection, query, where, runTransaction, etc.)
export * from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
export { db } from "./firebase.js";

import { db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Config do SISTEMA interno vive na colecao `configuracoes` (compartilhada com
// o site): `configuracoes/sistema` e `configuracoes/indicadores`.
export const CONFIG_SISTEMA_PADRAO = {
  nome_loja: "Amira",
  cnpj: "",
  formas_pagamento: ["dinheiro", "pix", "debito", "credito", "crediario"],
  comissao: { base: "total", percentual_padrao: 0 },
  // Parcelamento do PDV (credito/crediario parcelam; debito nao, mas pode
  // ter taxa em "1"): `maximo` = numero maximo de parcelas oferecido;
  // `minimo_parcela` = valor minimo (R$) por parcela (limita quantas
  // parcelas cabem numa venda pequena); `juros` = uma tabela POR FORMA de
  // pagamento, cada uma { "parcelas": {cliente, loja} } — `cliente` e o %
  // somado ao que o cliente paga, `loja` e o % de custo da loja (ex.: taxa
  // da maquininha) sobre o valor original. Chave ausente = sem juros/custo.
  // Ver public/assets/js/juros.js (parseTabelaJuros/infoParcela).
  parcelamento: { maximo: 12, minimo_parcela: 0, juros: { credito: {}, crediario: {}, debito: {} } },
};

export const CONFIG_INDICADORES_PADRAO = {
  site_url: "",
  percentual: 5,
  categorias_excluidas: ["iphones"],
};

export async function getConfigSistema() {
  const s = await getDoc(doc(db, "configuracoes", "sistema"));
  return s.exists() ? { ...CONFIG_SISTEMA_PADRAO, ...s.data() } : { ...CONFIG_SISTEMA_PADRAO };
}

export async function getConfigIndicadores() {
  const s = await getDoc(doc(db, "configuracoes", "indicadores"));
  return s.exists() ? { ...CONFIG_INDICADORES_PADRAO, ...s.data() } : { ...CONFIG_INDICADORES_PADRAO };
}

export const inicioDoDia = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const inicioDoMes = (d = new Date()) =>
  new Date(d.getFullYear(), d.getMonth(), 1);

export const periodoParaIntervalo = (periodo) => {
  const [a, m] = periodo.split("-").map(Number);
  return { inicio: new Date(a, m - 1, 1), fim: new Date(a, m, 1) };
};
