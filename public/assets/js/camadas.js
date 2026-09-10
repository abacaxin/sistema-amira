// ── Camadas de filtro (colecao `camadas` do site) ───────────────────────
// Portado de frontend/src/pages/services/camadas.js do repo do site, so com
// o necessario pro editor de produtos do sistema. A camada de MENOR `ordem`
// e a PRINCIPAL (indice 0 da lista ordenada).

import { db } from "./firebase.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const COLECAO = "camadas";

export function gerarSlug(nome) {
  return String(nome ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizarCamada(id, dados) {
  const opcoes = Array.isArray(dados.opcoes) ? dados.opcoes : [];
  return {
    id,
    nome: dados.nome || "",
    slug: dados.slug || "",
    ordem: Number(dados.ordem) || 1,
    opcoes: opcoes.map((o) => ({
      nome: o?.nome || "",
      slug: o?.slug || "",
      imagemURL: o?.imagemURL || "",
    })),
  };
}

export function sanitizarOpcoes(opcoes) {
  return (Array.isArray(opcoes) ? opcoes : [])
    .map((o) => ({
      nome: String(o?.nome ?? "").trim(),
      slug: o?.slug ? String(o.slug).trim() : gerarSlug(o?.nome),
      imagemURL: String(o?.imagemURL ?? "").trim(),
    }))
    .filter((o) => o.nome && o.slug);
}

/** Todas as camadas, menor `ordem` primeiro. A [0] e a principal. */
export async function listarCamadas() {
  const snap = await getDocs(query(collection(db, COLECAO), orderBy("ordem", "asc")));
  return snap.docs.map((d) => normalizarCamada(d.id, d.data()));
}

export function camadaPrincipal(camadas) {
  return (camadas && camadas.length > 0) ? camadas[0] : null;
}

export async function criarCamada({ nome }) {
  const slug = gerarSlug(nome);
  if (!slug) throw new Error("Informe um nome valido para a camada.");
  const existentes = await listarCamadas();
  if (existentes.some((c) => c.slug === slug)) {
    throw new Error("Ja existe uma camada com esse nome (ou muito parecido).");
  }
  const proximaOrdem = existentes.reduce((max, c) => Math.max(max, c.ordem), 0) + 1;
  return addDoc(collection(db, COLECAO), {
    nome: String(nome).trim(), slug, ordem: proximaOrdem, opcoes: [],
    criadoEm: serverTimestamp(),
  });
}

export async function renomearCamada(id, nome) {
  const limpo = String(nome ?? "").trim();
  if (!limpo) throw new Error("Informe um nome valido para a camada.");
  return updateDoc(doc(db, COLECAO, id), { nome: limpo });
}

export async function salvarOpcoes(id, opcoes) {
  return updateDoc(doc(db, COLECAO, id), { opcoes: sanitizarOpcoes(opcoes) });
}

export async function excluirCamada(id) {
  return deleteDoc(doc(db, COLECAO, id));
}

export async function reordenarCamadas(idsNaOrdem) {
  await Promise.all(
    idsNaOrdem.map((id, i) => updateDoc(doc(db, COLECAO, id), { ordem: i + 1 }))
  );
}
