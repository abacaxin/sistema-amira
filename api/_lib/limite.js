// ── Limite de requisições das funções serverless ───────────────────────
// Copiado do backend do site (repo Amira, api/_lib/limite.js).
//
// Na Vercel não existe estado entre invocações: cada chamada pode cair
// numa instância nova, então contador em memória não segura nada. O
// contador mora no Firestore, numa coleção que só o Admin SDK enxerga
// (o catch-all "allow read, write: if false" das firestore.rules fecha
// ela para o cliente).
//
// JANELA FIXA, não deslizante: é uma leitura e uma escrita por chamada,
// e para o volume desta loja isso basta. O objetivo não é perfeição
// estatística — é evitar que alguém rode /api/point/cobrar em laço e
// gere mil cobranças na maquininha (ou mil escritas no Firestore).
//
// FALHA ABERTA de propósito: se o Firestore estiver fora do ar, a venda
// continua. Um limitador que derruba o caixa é pior que a abusabilidade
// que ele previne.

const COLECAO = "limites";

/**
 * Consome uma unidade da cota de `chave`. Lança um erro com status 429
 * quando a cota estourou.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} chave            identifica quem está chamando — use o uid,
 *                                  nunca o IP (atrás de NAT/proxy o IP é de
 *                                  um prédio inteiro)
 * @param {{max: number, janelaSegundos: number, mensagem?: string}} opcoes
 */
async function limitar(db, chave, { max, janelaSegundos, mensagem }) {
  const agora = Date.now();
  const janela = Math.floor(agora / (janelaSegundos * 1000));
  const ref = db.collection(COLECAO).doc(String(chave).replace(/[^\w.@+-]/g, "_"));

  let contagem;
  try {
    contagem = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const dados = snap.exists ? snap.data() : null;
      const atual = dados && dados.janela === janela ? Number(dados.contagem) || 0 : 0;
      // Grava mesmo depois de estourar: assim uma rajada não "descansa"
      // só porque parou de receber resposta.
      tx.set(ref, { janela, contagem: atual + 1, atualizadoEm: new Date(agora) });
      return atual + 1;
    });
  } catch (erro) {
    console.warn("[limite] contador indisponível, seguindo sem limitar:", erro && erro.message);
    return;
  }

  if (contagem > max) {
    const e = new Error(mensagem || "Muitas tentativas seguidas. Espere um pouco e tente de novo.");
    e.status = 429;
    e.retryApos = janelaSegundos - Math.floor((agora % (janelaSegundos * 1000)) / 1000);
    throw e;
  }
}

module.exports = { limitar };
