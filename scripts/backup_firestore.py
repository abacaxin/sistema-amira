"""Exporta as colecoes do Firestore para arquivos JSON (backup simples).

Uso:
    python scripts/backup_firestore.py --dir backups
Gera:  backups/AAAA-MM-DD/<colecao>.json
"""
import argparse
import datetime as dt
import json
import os

from _firebase import init

# Projeto unificado flora-5754a (site + sistema interno).
COLECOES = [
    "usuarios", "produtos", "camadas", "configuracoes", "carrinhos",
    "pedidos", "metricas", "indicadores",
    "vendas", "caixa", "contadores", "comissoes",
]


def serial(v):
    if isinstance(v, dt.datetime):
        return v.isoformat()
    if hasattr(v, "path"):  # DocumentReference
        return {"__ref__": v.path}
    return str(v)


def dump_colecao(db, nome, destino):
    itens = []
    for doc in db.collection(nome).stream():
        itens.append({"id": doc.id, "data": doc.to_dict()})
        for sub in doc.reference.collections():
            for s in sub.stream():
                itens.append({"id": f"{doc.id}/{sub.id}/{s.id}", "data": s.to_dict()})
    caminho = os.path.join(destino, f"{nome}.json")
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(itens, f, ensure_ascii=False, indent=2, default=serial)
    return len(itens)


def main():
    ap = argparse.ArgumentParser(description="Backup do Firestore em JSON.")
    ap.add_argument("--dir", default="backups")
    ap.add_argument("--cred", default=None)
    args = ap.parse_args()

    db = init(args.cred)
    destino = os.path.join(args.dir, dt.date.today().isoformat())
    os.makedirs(destino, exist_ok=True)

    total = 0
    for nome in COLECOES:
        n = dump_colecao(db, nome, destino)
        total += n
        print(f"  {nome}: {n} documento(s)")
    print(f"Backup concluido em {destino} ({total} documentos).")


if __name__ == "__main__":
    main()
