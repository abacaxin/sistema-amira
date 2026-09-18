"""Conciliacao da maquininha Mercado Pago Point: cobrancas x vendas.

So LE (nunca grava nada). Cruza `cobrancas_point` (o que foi cobrado na
maquininha, escrito pela API na Vercel) com `vendas` (o que o PDV registrou,
`pagamentos[].point.cobranca_id`) e aponta o que nao bate:

  1. APROVADAS SEM VENDA — o cliente pagou no cartao e nenhuma venda usou
     essa cobranca (aba fechada, PDV recarregado no meio, cobranca de teste).
     E o caso que importa: dinheiro cobrado sem registro. Decida: registrar a
     venda na mao ou estornar (Vendas / API /api/point/estornar).
  2. PENDENTES PARADAS — cobranca que nao terminou (nao aprovada, recusada,
     cancelada nem expirada) e ja passou do tempo esperado.
  3. ESTORNADAS EM VENDA CONCLUIDA — a venda diz "concluida" mas o cartao
     foi estornado: o caixa esta contando um dinheiro que voltou.
  4. VENDA COM COBRANCA DESCONHECIDA — a venda aponta uma cobranca que nao
     existe em cobrancas_point (outro projeto/ambiente ou dado adulterado).
  5. Resumo: totais por status e quantas vendas usaram a taxa REAL da
     maquininha x estimada pela tabela de juros.

Uso:
    python scripts/conciliar_point.py
    python scripts/conciliar_point.py --desde 2026-09-01 --minutos-pendente 45
"""
import argparse
import datetime as dt

STATUS_ABERTOS = {"criando", "created", "at_terminal", "action_required", "erro"}


def _valor(d):
    return float(d.get("valor_pago") or d.get("valor") or 0)


def conciliar(cobrancas, vendas, agora, minutos_pendente=30):
    """Logica pura (sem Firestore) — recebe listas de dicts com "id" e devolve o relatorio.

    cobrancas: [{"id", "status", "valor", "valor_pago", "criado_em", ...}]
    vendas:    [{"id", "numero", "status", "pagamentos": [...]}]
    """
    ligadas = {}  # cobranca_id -> [(venda, pagamento)]
    for v in vendas:
        for p in v.get("pagamentos") or []:
            cid = (p.get("point") or {}).get("cobranca_id")
            if cid:
                ligadas.setdefault(cid, []).append((v, p))

    por_id = {c["id"]: c for c in cobrancas}
    limite = dt.timedelta(minutes=minutos_pendente)

    aprovadas_sem_venda, pendentes_paradas, estornadas_em_venda = [], [], []
    for c in cobrancas:
        st = c.get("status")
        vs = ligadas.get(c["id"], [])
        if st == "processed" and not vs:
            aprovadas_sem_venda.append(c)
        elif st in STATUS_ABERTOS:
            criado = c.get("criado_em")
            if criado is not None and agora - criado > limite:
                pendentes_paradas.append(c)
        elif st == "refunded":
            if any(v.get("status") == "concluida" for v, _ in vs):
                estornadas_em_venda.append(c)

    desconhecidas = [
        (cid, vs) for cid, vs in ligadas.items() if cid not in por_id
    ]

    por_status = {}
    for c in cobrancas:
        s = por_status.setdefault(c.get("status") or "?", {"qtd": 0, "valor": 0.0})
        s["qtd"] += 1
        s["valor"] += _valor(c)

    taxa_real = taxa_estimada = 0
    custo_real = 0.0
    for v in vendas:
        if v.get("status") != "concluida":
            continue
        for p in v.get("pagamentos") or []:
            if not p.get("point"):
                continue
            if p.get("origem_taxa") == "maquininha":
                taxa_real += 1
                custo_real += float(p.get("custo_loja") or 0)
            else:
                taxa_estimada += 1

    return {
        "aprovadas_sem_venda": aprovadas_sem_venda,
        "pendentes_paradas": pendentes_paradas,
        "estornadas_em_venda": estornadas_em_venda,
        "desconhecidas": desconhecidas,
        "por_status": por_status,
        "taxa_real": taxa_real,
        "taxa_estimada": taxa_estimada,
        "custo_real": round(custo_real, 2),
    }


def _fmt_data(d):
    return d.astimezone().strftime("%d/%m/%Y %H:%M") if isinstance(d, dt.datetime) else "?"


def _linha(c):
    return (
        f"  {_fmt_data(c.get('criado_em'))}  {c['id']}  R$ {_valor(c):.2f}  "
        f"{c.get('bandeira') or '-'}  {c.get('vendedor_nome') or '-'}  ordem {c.get('order_id') or '-'}"
    )


def imprimir(r):
    print("=== Conciliacao da maquininha (Mercado Pago Point) ===\n")

    print(f"1. Aprovadas SEM venda: {len(r['aprovadas_sem_venda'])}")
    for c in r["aprovadas_sem_venda"]:
        print(_linha(c))
    if r["aprovadas_sem_venda"]:
        print("   -> dinheiro cobrado no cartao sem venda registrada: registre a venda ou estorne.\n")

    print(f"2. Pendentes paradas: {len(r['pendentes_paradas'])}")
    for c in r["pendentes_paradas"]:
        print(f"  {_fmt_data(c.get('criado_em'))}  {c['id']}  status {c.get('status')}  R$ {c.get('valor')}")
    if r["pendentes_paradas"]:
        print("   -> confira na maquininha; abra a cobranca no PDV (Acompanhar) ou cancele.\n")

    print(f"3. Estornadas em venda concluida: {len(r['estornadas_em_venda'])}")
    for c in r["estornadas_em_venda"]:
        print(_linha(c))
    if r["estornadas_em_venda"]:
        print("   -> a venda ainda conta o dinheiro; cancele a venda em Vendas.\n")

    print(f"4. Vendas apontando cobranca desconhecida: {len(r['desconhecidas'])}")
    for cid, vs in r["desconhecidas"]:
        print(f"  {cid}  (venda #{vs[0][0].get('numero', vs[0][0]['id'])})")

    print("\nResumo por status:")
    for st, s in sorted(r["por_status"].items()):
        print(f"  {st:<16} {s['qtd']:>4}   R$ {s['valor']:.2f}")
    print(
        f"\nVendas com maquininha: {r['taxa_real']} com taxa REAL (custo total R$ {r['custo_real']:.2f}), "
        f"{r['taxa_estimada']} com taxa estimada pela tabela de juros."
    )


def main():
    ap = argparse.ArgumentParser(description="Concilia cobrancas da maquininha com as vendas (so leitura).")
    ap.add_argument("--desde", default=None, help="AAAA-MM-DD (opcional): so cobrancas criadas a partir dessa data")
    ap.add_argument("--minutos-pendente", type=int, default=30, help="apos quantos minutos uma cobranca aberta e considerada parada")
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    from _firebase import init  # import tardio: a logica acima roda/testa sem firebase-admin

    db = init(args.cred)

    q = db.collection("cobrancas_point")
    if args.desde:
        ano, mes, dia = map(int, args.desde.split("-"))
        q = q.where("criado_em", ">=", dt.datetime(ano, mes, dia, tzinfo=dt.timezone.utc))
    cobrancas = [{"id": d.id, **d.to_dict()} for d in q.stream()]

    # vendas de loja: as ligadas a cobranca vivem em pagamentos[].point
    vendas = [{"id": d.id, **d.to_dict()} for d in db.collection("vendas").where("canal", "==", "loja").stream()]

    imprimir(conciliar(cobrancas, vendas, dt.datetime.now(dt.timezone.utc), args.minutos_pendente))


if __name__ == "__main__":
    main()
