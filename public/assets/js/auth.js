import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  getAuth,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export function login(email, senha) {
  return signInWithEmailAndPassword(auth, email, senha);
}

export async function logout() {
  try { await signOut(auth); } catch (_) {}
  location.href = "/login";
}

/** Desloga sem redirecionar (usado quando o login e recusado por papel). */
export async function sairSilencioso() {
  try { await signOut(auth); } catch (_) {}
}

/** True se o perfil pode usar o sistema interno. */
export function ehEquipe(perfil) {
  return !!perfil && (perfil.role === "admin" || perfil.role === "vendedor");
}

/** Resolve { user, perfil } ou null. perfil = doc usuarios/{uid} (ou null se nao existir). */
export function currentPerfil() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, async (user) => {
      off();
      if (!user) return resolve(null);
      try {
        const s = await getDoc(doc(db, "usuarios", user.uid));
        resolve({ user, perfil: s.exists() ? { id: user.uid, ...s.data() } : null });
      } catch (_) {
        resolve({ user, perfil: null });
      }
    });
  });
}

/** Guarda de rota. Use no topo de cada pagina: const { perfil } = await requireAuth(). */
export async function requireAuth({ roles } = {}) {
  const r = await currentPerfil();
  if (!r || !r.user) {
    location.replace("/login");
    return new Promise(() => {});
  }
  if (!r.perfil) {
    telaMensagem("Seu usuario ainda nao tem perfil no sistema. Fale com o administrador.");
    return new Promise(() => {});
  }
  if (!ehEquipe(r.perfil)) {
    telaMensagem("Esta conta e de cliente da loja e nao tem acesso ao sistema interno.");
    return new Promise(() => {});
  }
  if (r.perfil.ativo === false) {
    telaMensagem("Seu acesso esta inativo. Fale com o administrador.");
    return new Promise(() => {});
  }
  if (roles && !roles.includes(r.perfil.role)) {
    location.replace("/dashboard");
    return new Promise(() => {});
  }
  return r;
}

/**
 * Cria um vendedor sem deslogar o ADM.
 * Usa uma instancia secundaria do Firebase App so para o createUser;
 * a gravacao do doc usuarios/{uid} acontece pela instancia primaria (ADM logado),
 * satisfazendo a regra `allow create: if adm()`.
 */
export async function criarVendedor({ nome, email, senha, comissao }) {
  const secApp = initializeApp(firebaseConfig, "sec-" + Date.now());
  const secAuth = getAuth(secApp);
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, email, senha);
    await setDoc(doc(db, "usuarios", cred.user.uid), {
      nome,
      email,
      role: "vendedor",
      ativo: true,
      comissao: comissao || {},
      criadoEm: serverTimestamp(),
      atualizadoEm: serverTimestamp(),
    });
    await signOut(secAuth);
    return cred.user.uid;
  } finally {
    await deleteApp(secApp).catch(() => {});
  }
}

function telaMensagem(msg) {
  document.body.innerHTML = `
    <div style="max-width:420px;margin:15vh auto;font-family:system-ui;text-align:center;padding:20px">
      <h2 style="color:#7a1f2b;letter-spacing:.12em">AMIRA</h2>
      <p>${msg}</p>
      <p><a href="/login" style="color:#9b3341">Voltar ao login</a></p>
    </div>`;
}
