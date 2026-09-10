"""Relatorio XLSX de comissoes de INDICADORES (link ?ref= do site) num periodo.

Le `pedidos` com campo `ref` e status != 'cancelado' no mes indicado. O pedido
do site NAO guarda valor: o total elegivel e DERIVADO do catalogo `produtos`
atual (preco de varejo com desconto, ou atacado, conforme o `modo` do item).
Itens de iPhone (opcao da camada principal com slug iniciando em "iphone") e de
slugs em configuracoes/indicadores.categorias_excluidas nao entram na base.

O pagamento das comissoes e manual — este relatorio so apura os valores.

Uso:
    python scripts/relatorio_indicadores.py --periodo 2026-09
"""
import argparse
import datetime as dt

from openpyxl import Workbook

from _firebase import init


def preco_item(produto, modo):
    if modo == "atacado":
        return float(produto.get("precoAtacado") or 0)
    base = float(produto.get("precoVarejo") or 0)
    pct = float(produto.get("descontoPercentual") or 0)
    if produto.get("descontoAtivo") is True and 1 <= pct <= 90:
        return round(base * (1 - pct / 100), 2)
    return base


def eh_iphone(produto, camada_principal, excluir):
    filtros = produto.get("filtros") or {}
    slugs = list(filtros.get(camada_principal, []) if camada_principal else [])
    legado = str(produto.get("categoria") or "")
    if legado:
        slugs.append(legado)
    for s in slugs:
        s = str(s).lower()
        if s.startswith("iphone") or s in excluir:
            return True
    return False


def main():
    ap = argparse.ArgumentParser(description="Relatorio de comissoes de indicadores.")
    ap.add_argument("--periodo", required=True, help="AAAA-MM")
    ap.add_argument("--saida", default=None)
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    ano, mes = map(int, args.periodo.split("-"))
    inicio = dt.datetime(ano, mes, 1, tzinfo=dt.timezone.utc)
    fim = dt.datetime(ano + (mes == 12), (mes % 12) + 1, 1, tzinfo=dt.timezone.utc)

    db = init(args.cred)

    cfg = (db.collection("configuracoes").document("indicadores").get().to_dict() or {})
    pct = float(cfg.get("percentual", 5) or 0)
    excluir = {str(s).lower().strip() for s in (cfg.get("categorias_excluidas") or [])}

    cam_docs = list(db.collection("camadas").order_by("ordem").limit(1).stream())
    camada_principal = (cam_docs[0].to_dict().get("slug") if cam_docs else None) or None

    produtos = {d.id: d.to_dict() for d in db.collection("produtos").stream()}
    indicadores = {
        (d.to_dict().get("codigo") or ""): (d.to_dict().get("nome") or d.id)
        for d in db.collection("indicadores").stream()
    }

    q = (
        db.collection("pedidos")
        .where("criadoEm", ">=", inicio)
        .where("criadoEm", "<", fim)
    )

    agg = {}
    for d in q.stream():
        p = d.to_dict()
        ref = p.get("ref")
        if not ref or p.get("status") == "cancelado":
            continue
        ref = str(ref)
        base = 0.0
        for it in p.get("itens") or []:
            produto = produtos.get(it.get("produtoId"))
            if not produto:
                continue
            if eh_iphone(produto, camada_principal, excluir):
                continue
            modo = "atacado" if it.get("modo") == "atacado" else "varejo"
            qtd = max(0, int(it.get("quantidade") or 0))
            base += preco_item(produto, modo) * qtd
        base = round(base, 2)
        a = agg.setdefault(ref, {"qtd": 0, "base": 0.0})
        a["qtd"] += 1
        a["base"] = round(a["base"] + base, 2)

    wb = Workbook()
    ws = wb.active
    ws.title = f"Indicadores {args.periodo}"
    ws.append(["Indicador", "Codigo", "Pedidos", "Base elegivel (R$)", f"Comissao ({pct:g}%) (R$)"])
    tot_base = tot_com = 0.0
    for ref, a in sorted(agg.items(), key=lambda kv: indicadores.get(kv[0], kv[0]).lower()):
        com = round(a["base"] * pct / 100, 2)
        tot_base += a["base"]
        tot_com += com
        ws.append([indicadores.get(ref, f"(sem cadastro) {ref}"), ref, a["qtd"], a["base"], com])
    ws.append([])
    ws.append(["TOTAL", "", sum(a["qtd"] for a in agg.values()), round(tot_base, 2), round(tot_com, 2)])

    saida = args.saida or f"indicadores_{args.periodo}.xlsx"
    wb.save(saida)
    print(f"Relatorio salvo em {saida} ({len(agg)} indicador(es)).")


if __name__ == "__main__":
    main()
