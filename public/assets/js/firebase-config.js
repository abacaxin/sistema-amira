// =============================================================================
//  PROJETO FIREBASE COMPARTILHADO COM O SITE  ->  flora-5754a
//  O sistema interno e o site (Flora/Amira) usam o MESMO Firestore/Auth.
//  Console: Firebase > Configuracoes do projeto > Seus apps > App da Web.
//
//  ATENCAO (App Check): o site usa Firebase App Check (reCAPTCHA v3). Hoje
//  esta DESLIGADO (chave ainda e placeholder no site). Quando o site ativar
//  o "Enforce" para Firestore/Auth, este app tambem vai precisar inicializar
//  o App Check com a chave do dominio onde o sistema for hospedado, senao o
//  Firebase passa a recusar as requisicoes. Ver ~/Documentos/Amira/
//  docs/MANUAL_CONFIGURACAO.md.
// =============================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyACUAYAfglk9tMu3RpbBbEgQSjTC8eLXYU",
  authDomain: "flora-5754a.firebaseapp.com",
  projectId: "flora-5754a",
  storageBucket: "flora-5754a.firebasestorage.app",
  messagingSenderId: "819737384786",
  appId: "1:819737384786:web:0e7152e6065e13c9c58c8b",
  measurementId: "G-CYJD1Y9V2H"
};
