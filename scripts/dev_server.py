"""Servidor estatico local para desenvolver/visualizar o front-end sem o Firebase CLI.

Serve a pasta public/ e resolve "clean URLs" (/dashboard -> dashboard.html),
igual ao Firebase Hosting.

Uso:
    python scripts/dev_server.py            # http://localhost:5173
    PORT=8080 python scripts/dev_server.py

Observacao: o login e os dados so funcionam depois de preencher
public/assets/js/firebase-config.js com as credenciais de um projeto Firebase real
(o Firebase Auth/Firestore funcionam a partir de localhost sem precisar do CLI).
Sem isso, voce ve apenas a tela de login e o visual do sistema.
"""
import http.server
import os
import socketserver

RAIZ = os.path.join(os.path.dirname(__file__), "..", "public")
PORT = int(os.environ.get("PORT", "5173"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.abspath(RAIZ), **kw)

    def translate_path(self, path):
        p = super().translate_path(path)
        if not os.path.exists(p) and not os.path.splitext(p)[1] and os.path.exists(p + ".html"):
            return p + ".html"
        return p

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Preview do Sistema Amira em  http://localhost:{PORT}/")
        print("Ctrl+C para parar.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
