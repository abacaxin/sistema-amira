"""Cria/garante um usuario ADMIN e as configuracoes iniciais do sistema interno.

Projeto unificado com o site: flora-5754a. O papel de admin e `role == "admin"`
(mesmo do site). Config do sistema vive em `configuracoes/sistema` e
`configuracoes/indicadores`.

Uso:
    python scripts/bootstrap_admin.py --email dono@amira.com --senha "trocar123" --nome "Dono"
"""
import argparse

from firebase_admin import auth, firestore

from _firebase import init


def main():
    ap = argparse.ArgumentParser(description="Cria/garante um usuario ADMIN.")
    ap.add_argument("--email", required=True)
    ap.add_argument("--senha", required=True)
    ap.add_argument("--nome", required=True)
    ap.add_argument("--cred", default=None, help="Caminho do serviceAccount.json")
    args = ap.parse_args()

    db = init(args.cred)

    try:
        user = auth.get_user_by_email(args.email)
        print(f"Usuario ja existia no Auth: {user.uid}")
    except auth.UserNotFoundError:
        user = auth.create_user(
            email=args.email, password=args.senha, display_name=args.nome
        )
        print(f"Usuario criado no Auth: {user.uid}")

    db.collection("usuarios").document(user.uid).set(
        {
            "nome": args.nome,
            "email": args.email,
            "role": "admin",
            "ativo": True,
            "comissao": {},
            "criadoEm": firestore.SERVER_TIMESTAMP,
            "atualizadoEm": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )
    print("Perfil ADMIN gravado em usuarios/" + user.uid)

    sis = db.collection("configuracoes").document("sistema")
    if not sis.get().exists:
        sis.set(
            {
                "nome_loja": "Amira",
                "cnpj": "",
                "formas_pagamento": ["dinheiro", "pix", "debito", "credito"],
                "comissao": {"base": "total", "percentual_padrao": 0},
                "atualizadoEm": firestore.SERVER_TIMESTAMP,
            }
        )
        print("configuracoes/sistema criada com valores padrao.")
    else:
        print("configuracoes/sistema ja existia - mantida.")

    ind = db.collection("configuracoes").document("indicadores")
    if not ind.get().exists:
        ind.set(
            {
                "site_url": "",
                "percentual": 5,
                "janela_dias": 7,
                "categorias_excluidas": ["iphones"],
                "atualizadoEm": firestore.SERVER_TIMESTAMP,
            }
        )
        print("configuracoes/indicadores criada com valores padrao.")
    else:
        print("configuracoes/indicadores ja existia - mantida.")

    print("\nPronto. Faca login no sistema com esse e-mail e senha.")


if __name__ == "__main__":
    main()
