// Leitura/gravação do .env local — só pros scripts de desenvolvimento
// (npm run api:dev / npm run point:check). Nada aqui imprime valor de variável.
// O .env está no .gitignore; na Vercel as variáveis vêm do painel, não daqui.

import fs from "node:fs";

// Valor de uma linha KEY=valor: aspas simples ou duplas protegem espaços e
// "#" (dá pra colar o JSON da service account entre aspas simples); sem
// aspas, " # comentário" no fim da linha é descartado.
function valorDaLinha(resto) {
  const r = resto.trim();
  const aspa = r[0];
  if (aspa === '"' || aspa === "'") {
    const fim = r.lastIndexOf(aspa);
    if (fim > 0) return r.slice(1, fim);
  }
  return r.replace(/\s+#.*$/, "").trim();
}

/** Texto de um .env → { CHAVE: "valor" }. Ignora comentários, linhas em branco e lixo. */
export function parsearEnv(texto) {
  const env = {};
  for (const linhaBruta of String(texto ?? "").split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith("#")) continue;
    const m = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    env[m[1]] = valorDaLinha(m[2]);
  }
  return env;
}

/**
 * Lê o arquivo e joga as chaves em `env` (process.env por padrão) SEM
 * sobrescrever o que já estiver definido no ambiente — quem exportou a
 * variável no terminal manda mais que o arquivo.
 * @returns {{carregado:boolean, chaves:string[]}} chaves = as que vieram do arquivo (só os nomes)
 */
export function carregarEnv({ arquivo, env = process.env, ler = (c) => fs.readFileSync(c, "utf8") } = {}) {
  let texto;
  try {
    texto = ler(arquivo);
  } catch {
    return { carregado: false, chaves: [] };
  }
  const chaves = [];
  for (const [chave, valor] of Object.entries(parsearEnv(texto))) {
    if (env[chave] === undefined || env[chave] === "") {
      env[chave] = valor;
      chaves.push(chave);
    }
  }
  return { carregado: true, chaves };
}

/**
 * Devolve o texto do .env com CHAVE=valor: troca a linha existente ou
 * acrescenta no fim. O resto do arquivo (comentários, ordem, quebra de
 * linha CRLF/LF) fica como estava.
 */
export function gravarChave(texto, chave, valor) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) throw new Error(`Nome de variável inválido: ${chave}`);
  if (/[\r\n]/.test(String(valor))) throw new Error("O valor não pode ter quebra de linha.");

  const original = String(texto ?? "");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const linhas = original === "" ? [] : original.split(/\r?\n/);
  const ehDaChave = (l) => !l.trim().startsWith("#") && new RegExp(`^\\s*(?:export\\s+)?${chave}\\s*=`).test(l);

  const nova = `${chave}=${valor}`;
  const i = linhas.findIndex(ehDaChave);
  if (i >= 0) {
    linhas[i] = nova;
  } else if (linhas.length && linhas[linhas.length - 1] === "") {
    linhas.splice(linhas.length - 1, 0, nova); // o arquivo terminava com quebra de linha
  } else {
    linhas.push(nova);
  }
  const saida = linhas.join(eol);
  return saida.endsWith(eol) ? saida : saida + eol;
}

/** gravarChave() direto no arquivo (cria se não existir). */
export function gravarChaveNoArquivo(
  arquivo,
  chave,
  valor,
  { ler = (c) => fs.readFileSync(c, "utf8"), escrever = (c, t) => fs.writeFileSync(c, t) } = {}
) {
  let atual = "";
  try {
    atual = ler(arquivo);
  } catch {
    /* arquivo novo */
  }
  escrever(arquivo, gravarChave(atual, chave, valor));
}
