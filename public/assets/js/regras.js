import { round2 } from "./money.js";

/**
 * Calcula a comissao de uma venda.
 * Regra de base (por ordem de prioridade): override do vendedor > config da loja > "total".
 *   - "total"              : percentual sobre o valor final pago (com desconto)
 *   - "total_sem_desconto" : percentual sobre a soma dos itens a preco cheio
 *   - "margem"             : percentual sobre (venda - custo)
 */
export function calcularComissao({ itens, subtotal, total, config, perfil }) {
  const c = perfil?.comissao || {};
  const base = c.base || config?.comissao?.base || "total";
  const pct = Number(c.percentual ?? config?.comissao?.percentual_padrao ?? 0);

  let valorBase;
  if (base === "total_sem_desconto") {
    valorBase = subtotal;
  } else if (base === "margem") {
    valorBase = itens.reduce(
      (s, it) => s + (it.preco_unit - (it.preco_custo || 0)) * it.qtd,
      0
    );
  } else {
    valorBase = total;
  }
  valorBase = Math.max(0, round2(valorBase));

  return {
    base,
    percentual: pct,
    valor_base: valorBase,
    valor: round2((valorBase * pct) / 100),
    status: "pendente",
  };
}

// A comissao de INDICADORES (link ?ref= do site) e apurada em
// pages/indicadores.js, derivando os totais dos `pedidos` do site via
// `baseElegivelIndicador` em produtos-schema.js (o pedido do site nao guarda
// valor monetario).
