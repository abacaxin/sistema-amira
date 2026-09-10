"""Inicializacao compartilhada do Firebase Admin SDK para os scripts."""
import os
import sys

import firebase_admin
from firebase_admin import credentials, firestore


def init(cred_path: str | None = None):
    """Inicializa o app Admin e devolve o cliente Firestore."""
    if not firebase_admin._apps:
        cred_path = (
            cred_path
            or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
            or "serviceAccount.json"
        )
        if not os.path.exists(cred_path):
            sys.exit(
                f"Credencial nao encontrada: {cred_path}\n"
                "Defina GOOGLE_APPLICATION_CREDENTIALS ou passe --cred com o caminho "
                "do JSON da conta de servico."
            )
        firebase_admin.initialize_app(credentials.Certificate(cred_path))
    return firestore.client()
