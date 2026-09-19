import test from "node:test";
import assert from "node:assert/strict";
import { resumoTotais, infoParcela } from "../public/assets/js/juros.js";

// Linhas no formato que o PDV monta (pagamentosComJuros).
const dinheiro = (valor) => ({ forma: "dinheiro", valor });
const credito = (valor, cliente, loja, parcelas = 3) => {
  const i = infoParcela(valor, parcelas, { cliente, loja });
  return {
    forma: "credito", valor, parcelas, juros_pct: i.pctCliente, pct_loja: i.pctLoja,
    valor_com_juros: i.valorComJuros, custo_loja: i.custoLoja, valor_liquido: i.valorLiquido
  };
};
const naMaquininha = (valor, valorPago, custo) => ({
  forma: "credito", valor, valor_com_juros: valorPago, custo_loja: custo, valor_liquido: Math.round((valor - custo) * 100) / 100,
  origem_taxa: "maquininha", point: { status: "processed", order_id: "ORD1" }
});

test("venda sem juros nem custo (dinheiro): o painel fica enxuto, sem 'Valor original' nem custo", () => {
  const r = resumoTotais({ total: 100, pago: 100, pagamentos: [dinheiro(100)] });
  assert.equal(r.totalCobrado, 100);
  assert.equal(r.valorOriginal, 100);
  assert.equal(r.pagoCobrado, 100);
  assert.equal(r.falta, 0);
  assert.equal(r.mostrarOriginal, false);
  assert.equal(r.mostrarReceber, false);
  assert.equal(r.estimadoCobranca, false);
});

test("o caso do print: loja absorve a taxa (cliente 0) → Total = original, com custo e valor a receber", () => {
  // R$ 119,90 no cartao, custo da loja R$ 6,64 (estimativa da tabela)
  const linha = { forma: "credito", valor: 119.9, parcelas: 3, valor_com_juros: 119.9, custo_loja: 6.64, valor_liquido: 113.26, pct_loja: 5.54 };
  const r = resumoTotais({ total: 119.9, pago: 119.9, pagamentos: [linha] });
  assert.equal(r.totalCobrado, 119.9);
  assert.equal(r.valorOriginal, 119.9);
  assert.equal(r.custoLojaTotal, 6.64);
  assert.equal(r.valorAReceber, 113.26);
  assert.equal(r.pagoCobrado, 119.9);
  assert.equal(r.falta, 0);
  assert.equal(r.mostrarOriginal, true, "ha custo → mostra o Valor original mesmo igual ao Total");
  assert.equal(r.mostrarReceber, true);
  assert.equal(r.estimadoReceber, true, "custo veio da tabela (nao da maquininha)");
  assert.equal(r.estimadoCobranca, false, "o cliente paga o preco cheio: nada estimado no total");
});

test("cliente paga juros: Total = valor cobrado (com juros), original fica separado, a receber = original - custo", () => {
  const r = resumoTotais({ total: 100, pago: 100, pagamentos: [credito(100, 5, 2)] });
  assert.equal(r.totalCobrado, 105);
  assert.equal(r.valorOriginal, 100);
  assert.equal(r.custoLojaTotal, 2);
  assert.equal(r.valorAReceber, 98, "o juros do cliente NAO entra no valor a receber");
  assert.equal(r.pagoCobrado, 105);
  assert.equal(r.falta, 0);
  assert.equal(r.mostrarOriginal, true);
  assert.equal(r.estimadoCobranca, true, "o juros do cliente ainda e estimativa da tabela");
});

test("venda paga na maquininha: numeros REAIS (nada 'estimado'), e o total e o que a maquininha cobrou", () => {
  // maquininha cobrou 114,31 do cliente e o custo real foi 5,31
  const r = resumoTotais({ total: 100, pago: 100, pagamentos: [naMaquininha(100, 114.31, 5.31)] });
  assert.equal(r.totalCobrado, 114.31);
  assert.equal(r.valorOriginal, 100);
  assert.equal(r.custoLojaTotal, 5.31);
  assert.equal(r.valorAReceber, 94.69);
  assert.equal(r.pagoCobrado, 114.31);
  assert.equal(r.estimadoCobranca, false);
  assert.equal(r.estimadoReceber, false);
});

test("maquininha sem taxa real (origem 'estimada'): o custo continua marcado como estimado", () => {
  const linha = { ...naMaquininha(100, 100, 4), origem_taxa: "estimada" };
  assert.equal(resumoTotais({ total: 100, pago: 100, pagamentos: [linha] }).estimadoReceber, true);
});

test("pagamento misto: dinheiro + credito com juros → total = 40 + 63; original 100; custo so do cartao", () => {
  const r = resumoTotais({ total: 100, pago: 100, pagamentos: [dinheiro(40), credito(60, 5, 2)] });
  assert.equal(r.totalCobrado, 103);
  assert.equal(r.pagoCobrado, 103);
  assert.equal(r.custoLojaTotal, 1.2);
  assert.equal(r.valorAReceber, 98.8);
  assert.equal(r.falta, 0);
});

test("alocacao parcial: o que falta entra no total pelo valor de tabela; a conta fecha (total = pago + falta)", () => {
  const r = resumoTotais({ total: 100, pago: 40, pagamentos: [dinheiro(40)] });
  assert.equal(r.falta, 60);
  assert.equal(r.pagoCobrado, 40);
  assert.equal(r.totalCobrado, 100);
  assert.equal(round(r.pagoCobrado + r.falta), r.totalCobrado);

  const comJuros = resumoTotais({ total: 100, pago: 60, pagamentos: [credito(60, 5, 2)] });
  assert.equal(comJuros.pagoCobrado, 63);
  assert.equal(comJuros.falta, 40);
  assert.equal(comJuros.totalCobrado, 103);
  assert.equal(round(comJuros.pagoCobrado + comJuros.falta), comJuros.totalCobrado);
});

test("sem nenhum pagamento ainda: total = valor original e nada de custo", () => {
  const r = resumoTotais({ total: 119.9, pago: 0, pagamentos: [] });
  assert.equal(r.totalCobrado, 119.9);
  assert.equal(r.pagoCobrado, 0);
  assert.equal(r.falta, 119.9);
  assert.equal(r.mostrarOriginal, false);
  assert.equal(r.mostrarReceber, false);
});

test("dinheiro a mais (troco): o total continua sendo o valor da venda e o troco aparece como falta negativa", () => {
  const r = resumoTotais({ total: 100, pago: 120, pagamentos: [dinheiro(120)] });
  assert.equal(r.falta, -20);
  assert.equal(r.pagoCobrado, 120);
  assert.equal(r.totalCobrado, 100);
});

test("centavos: arredonda a cada passo (sem 0,0000001 sobrando)", () => {
  const r = resumoTotais({ total: 33.33, pago: 33.33, pagamentos: [credito(33.33, 7.5, 3.3, 2)] });
  for (const k of ["totalCobrado", "pagoCobrado", "custoLojaTotal", "valorAReceber", "falta"]) {
    assert.equal(r[k], round(r[k]), `${k} tem mais de 2 casas`);
  }
});

test("entradas vazias/omitidas nao estouram", () => {
  const r = resumoTotais({ total: 0, pago: 0 });
  assert.equal(r.totalCobrado, 0);
  assert.equal(r.valorAReceber, 0);
  assert.equal(r.mostrarOriginal, false);
});

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
