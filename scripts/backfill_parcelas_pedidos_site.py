"""Backfill: copia `pedidos/{id}.pagamento.parcelas` pros espelhos JA
EXISTENTES em `vendas` (canal "site"), pra pedidos entregues antes do
sistema comecar a copiar esse campo na hora da confirmacao de entrega.

O webhook do Mercado Pago (repo do site) grava
`pedidos/{id}.pagamento.parcelas` com a quantidade de parcelas que o
cliente escolheu no Checkout Pro (so a contagem — o site nao calcula
juros de parcelamento, isso e o Mercado Pago quem faz). Quando um pedido
do site vira "entregue", `pedidos.js` cria `vendas/site_{pedidoId}` UMA
UNICA VEZ e nunca reescreve depois — pedidos entregues antes dessa
mudanca ficaram com o espelho sem `parcelas`, mesmo que o pedido
original ja tivesse o campo.

So ADICIONA `parcelas` ao (unico) pagamento do espelho, e so quando: o
pedido original tem parcelas > 1 (a vista/PIX nao precisa de nada — o
proprio MP devolve 1 nesses casos) e o espelho ainda nao tem parcelas
gravado (idempotente — pula espelhos ja migrados por uma rodada anterior
deste script, ou ja criados com o campo pelo codigo novo). Nunca mexe em
`forma`/`valor` ou em qualquer outro campo da venda.

Por padrao roda em modo RELATORIO (nao grava nada). Use --aplicar pra gravar.

Uso:
    python scripts/backfill_parcelas_pedidos_site.py
    python scripts/backfill_parcelas_pedidos_site.py --aplicar
"""
import argparse

from _firebase import init


def main():
    ap = argparse.ArgumentParser(description="Backfill de parcelas do site nos espelhos de vendas.")
    ap.add_argument("--aplicar", action="store_true", help="Grava de verdade (padrao: so relatorio).")
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    db = init(args.cred)

    vendas_site = list(
        db.collection("vendas")
        .where("canal", "==", "site")
        .where("status", "==", "concluida")
        .stream()
    )
    print(f"{len(vendas_site)} venda(s) de site concluida(s) encontrada(s).")

    a_gravar = []
    sem_pedido_id = 0
    sem_pagamento = 0
    ja_tem_parcelas = 0
    sem_parcela_no_pedido = 0
    pedido_nao_encontrado = 0

    for venda_doc in vendas_site:
        venda = venda_doc.to_dict()
        rotulo = venda.get("codigoRetirada") or venda_doc.id

        pedido_id = venda.get("pedidoId")
        if not pedido_id:
            sem_pedido_id += 1
            continue

        pagamentos = venda.get("pagamentos") or []
        if not pagamentos:
            sem_pagamento += 1
            continue
        if pagamentos[0].get("parcelas") is not None:
            ja_tem_parcelas += 1
            continue

        pedido_snap = db.collection("pedidos").document(str(pedido_id)).get()
        if not pedido_snap.exists:
            pedido_nao_encontrado += 1
            continue

        parcelas_raw = (pedido_snap.to_dict().get("pagamento") or {}).get("parcelas")
        parcelas = int(parcelas_raw) if parcelas_raw else 0
        if parcelas <= 1:
            sem_parcela_no_pedido += 1
            continue

        novos_pagamentos = [{**pagamentos[0], "parcelas": parcelas}, *pagamentos[1:]]
        a_gravar.append((venda_doc.reference, novos_pagamentos))
        print(f"  {rotulo}: parcelas={parcelas}")

    print(
        f"{len(a_gravar)} venda(s) a atualizar de {len(vendas_site)} — "
        f"{ja_tem_parcelas} ja tinham parcelas, {sem_parcela_no_pedido} sao a vista/sem parcela no pedido, "
        f"{pedido_nao_encontrado} com pedido nao encontrado, {sem_pedido_id} sem pedidoId, "
        f"{sem_pagamento} sem pagamento registrado."
    )

    if not args.aplicar:
        print("Modo relatorio (dry-run) — nada foi gravado. Rode de novo com --aplicar pra gravar.")
        return

    BATCH_MAX = 400
    for i in range(0, len(a_gravar), BATCH_MAX):
        lote = a_gravar[i : i + BATCH_MAX]
        batch = db.batch()
        for ref, novos_pagamentos in lote:
            batch.update(ref, {"pagamentos": novos_pagamentos})
        batch.commit()
    print(f"Gravado: {len(a_gravar)} venda(s) atualizada(s).")


if __name__ == "__main__":
    main()
