"""Backfill do CUSTO DA LOJA (taxa de maquininha/financiamento) em vendas
ANTIGAS da loja fisica, feitas antes da Fase 1 de juros reais (PR de
"Aplica juros de verdade no PDV").

Antes dessa fase, o "juros" mostrado no PDV era cosmetico: o valor que o
cliente pagou de fato (`pagamentos[].valor` e `vendas.total`) NUNCA incluia
juros de verdade, mesmo quando a tela chegou a gravar um `valor_com_juros`/
`juros_pct` antigo (esses campos, quando existem em vendas antigas, sao
so um preview que ficou salvo — nao o que foi cobrado). Por isso este script
NAO inventa juros de cliente que nunca existiram: ele usa o `total`/`valor`
ja registrado (o que o cliente pagou de verdade) e so calcula, com a tabela
de juros ATUAL configurada em Configuracoes, qual teria sido o CUSTO DA LOJA
(taxa de maquininha/financiamento) em cada pagamento em credito/crediario/
debito — inclusive a vista (1x), ja que taxa de credito/debito a vista
tambem e custo real. `valor_liquido = valor - custo_loja` por pagamento, e a
venda ganha `custo_loja_total`/`valor_liquido` agregados.

So ADICIONA campos novos (`custo_loja`, `valor_liquido` por pagamento;
`custo_loja_total`, `valor_liquido` na venda) — nunca reescreve `valor`,
`total`, `juros_pct` ou `valor_com_juros` existentes. Idempotente: pula
vendas que ja tem `valor_liquido` gravado (ja processadas por este script ou
pela Fase 1 em tempo real).

Por padrao roda em modo RELATORIO (nao grava nada). Use --aplicar pra gravar.

Uso:
    python scripts/backfill_juros_historico.py                    # relatorio, tudo
    python scripts/backfill_juros_historico.py --desde 2026-01 --ate 2026-06
    python scripts/backfill_juros_historico.py --aplicar           # grava de vez
"""
import argparse
import datetime as dt

from _firebase import init

FORMAS_JUROS = {"credito", "crediario", "debito"}


def round2(v):
    return round(float(v or 0), 2)


def taxa_loja(juros_cfg, forma, parcelas):
    """Pct de custo da loja configurado HOJE pra forma+parcelas (0 se nao ha)."""
    tabela = (juros_cfg or {}).get(forma) or {}
    entrada = tabela.get(str(parcelas)) or {}
    return float(entrada.get("loja") or 0)


def recalcular_venda(venda, juros_cfg):
    """Devolve (pagamentos_novos, custo_loja_total, valor_liquido) ou None se
    nenhum pagamento dessa venda tem taxa de loja configurada."""
    pagamentos = venda.get("pagamentos") or []
    novos = []
    custo_loja_total = 0.0
    algum_aplicado = False
    for p in pagamentos:
        forma = p.get("forma")
        valor = round2(p.get("valor"))
        if forma not in FORMAS_JUROS:
            novos.append(p)
            continue
        parcelas = int(p.get("parcelas") or 1)
        pct_loja = taxa_loja(juros_cfg, forma, parcelas)
        if pct_loja <= 0:
            novos.append(p)
            continue
        custo_loja = round2(valor * pct_loja / 100)
        valor_liquido_pg = round2(valor - custo_loja)
        custo_loja_total = round2(custo_loja_total + custo_loja)
        algum_aplicado = True
        novos.append({**p, "custo_loja": custo_loja, "valor_liquido": valor_liquido_pg})
    if not algum_aplicado:
        return None
    total = round2(venda.get("total"))
    valor_liquido = round2(total - custo_loja_total)
    return novos, custo_loja_total, valor_liquido


def main():
    ap = argparse.ArgumentParser(description="Backfill de custo_loja/valor_liquido em vendas antigas.")
    ap.add_argument("--desde", default=None, help="AAAA-MM (opcional, inclusive)")
    ap.add_argument("--ate", default=None, help="AAAA-MM (opcional, exclusive)")
    ap.add_argument("--aplicar", action="store_true", help="Grava de verdade (padrao: so relatorio).")
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    db = init(args.cred)

    cfg = (db.collection("configuracoes").document("sistema").get().to_dict() or {})
    juros_cfg = (cfg.get("parcelamento") or {}).get("juros") or {}
    if not any((juros_cfg.get(f) or {}) for f in FORMAS_JUROS):
        print("Nenhuma tabela de juros configurada em Configuracoes (parcelamento.juros) — nada a fazer.")
        return

    q = (
        db.collection("vendas")
        .where("canal", "==", "loja")
        .where("status", "==", "concluida")
    )
    if args.desde:
        ano, mes = map(int, args.desde.split("-"))
        q = q.where("data", ">=", dt.datetime(ano, mes, 1, tzinfo=dt.timezone.utc))
    if args.ate:
        ano, mes = map(int, args.ate.split("-"))
        q = q.where("data", "<", dt.datetime(ano, mes, 1, tzinfo=dt.timezone.utc))

    docs = list(q.stream())
    print(f"{len(docs)} venda(s) de loja concluida(s) no periodo.")

    pendentes = [d for d in docs if d.to_dict().get("valor_liquido") is None]
    ja_feitas = len(docs) - len(pendentes)
    if ja_feitas:
        print(f"{ja_feitas} ja tem valor_liquido gravado — pulando (idempotente).")

    a_gravar = []
    for d in pendentes:
        venda = d.to_dict()
        resultado = recalcular_venda(venda, juros_cfg)
        if resultado is None:
            continue
        pagamentos_novos, custo_loja_total, valor_liquido = resultado
        a_gravar.append((d.reference, venda, pagamentos_novos, custo_loja_total, valor_liquido))
        data_str = venda.get("data").strftime("%Y-%m-%d") if venda.get("data") else "?"
        print(
            f"  venda {venda.get('numero', d.id)} ({data_str}): total={venda.get('total')} "
            f"custo_loja_total={custo_loja_total} valor_liquido={valor_liquido}"
        )

    print(f"{len(a_gravar)} venda(s) com taxa de loja aplicavel de {len(pendentes)} pendente(s).")

    if not args.aplicar:
        print("Modo relatorio (dry-run) — nada foi gravado. Rode de novo com --aplicar pra gravar.")
        return

    BATCH_MAX = 400
    for i in range(0, len(a_gravar), BATCH_MAX):
        lote = a_gravar[i : i + BATCH_MAX]
        batch = db.batch()
        for ref, _venda, pagamentos_novos, custo_loja_total, valor_liquido in lote:
            batch.update(ref, {
                "pagamentos": pagamentos_novos,
                "custo_loja_total": custo_loja_total,
                "valor_liquido": valor_liquido,
            })
        batch.commit()
    print(f"Gravado: {len(a_gravar)} venda(s) atualizada(s).")


if __name__ == "__main__":
    main()
