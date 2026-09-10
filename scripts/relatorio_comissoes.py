"""Gera um relatorio XLSX de comissoes por vendedor num periodo (mes).

Considera apenas vendas: canal == 'loja' e status == 'concluida'.

Uso:
    python scripts/relatorio_comissoes.py --periodo 2026-09
"""
import argparse
import datetime as dt

from openpyxl import Workbook

from _firebase import init


def main():
    ap = argparse.ArgumentParser(description="Relatorio de comissoes por periodo.")
    ap.add_argument("--periodo", required=True, help="AAAA-MM")
    ap.add_argument("--saida", default=None)
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    ano, mes = map(int, args.periodo.split("-"))
    inicio = dt.datetime(ano, mes, 1, tzinfo=dt.timezone.utc)
    fim = dt.datetime(ano + (mes == 12), (mes % 12) + 1, 1, tzinfo=dt.timezone.utc)

    db = init(args.cred)

    nomes = {
        u.id: (u.to_dict().get("nome") or u.id)
        for u in db.collection("usuarios").stream()
    }

    q = (
        db.collection("vendas")
        .where("canal", "==", "loja")
        .where("status", "==", "concluida")
        .where("data", ">=", inicio)
        .where("data", "<", fim)
    )

    agg = {}
    for d in q.stream():
        v = d.to_dict()
        uid = v.get("vendedor_uid") or "sem_vendedor"
        com = v.get("comissao") or {}
        a = agg.setdefault(uid, {"qtd": 0, "vendas": 0.0, "comissao": 0.0})
        a["qtd"] += 1
        a["vendas"] += float(v.get("total") or 0)
        a["comissao"] += float(com.get("valor") or 0)

    wb = Workbook()
    ws = wb.active
    ws.title = f"Comissoes {args.periodo}"
    ws.append(["Vendedor", "Qtd vendas", "Total vendas (R$)", "Comissao (R$)"])
    for uid, a in sorted(agg.items(), key=lambda kv: nomes.get(kv[0], kv[0]).lower()):
        ws.append(
            [nomes.get(uid, uid), a["qtd"], round(a["vendas"], 2), round(a["comissao"], 2)]
        )
    ws.append([])
    ws.append(
        [
            "TOTAL",
            sum(a["qtd"] for a in agg.values()),
            round(sum(a["vendas"] for a in agg.values()), 2),
            round(sum(a["comissao"] for a in agg.values()), 2),
        ]
    )

    saida = args.saida or f"comissoes_{args.periodo}.xlsx"
    wb.save(saida)
    print(f"Relatorio salvo em {saida} ({len(agg)} vendedor(es)).")


if __name__ == "__main__":
    main()
