// ── npm run point:check — "dá pra cobrar na maquininha?" ───────────────
// Confere, item por item, o que precisa estar certo (token do Mercado Pago,
// service account do Firebase, terminais da conta, modo PDV) e diz o que
// fazer em cada item que falhar. NÃO cobra nada e não mexe em venda.
//
//   npm run point:check                              só confere
//   npm run point:check -- --gravar                  + grava o terminal no .env
//   npm run point:check -- --gravar --colocar-pdv    + coloca o terminal em modo PDV
//   npm run point:check -- --terminal PAX_A910__X    escolhe o terminal (se houver mais de um)
//
// Sai com código 1 se algum item estiver em erro. Nunca imprime valor de
// segredo — só se está configurado e o que o Mercado Pago respondeu.

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { carregarEnv, gravarChaveNoArquivo } from "./lib/env.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exigir = createRequire(import.meta.url);
// point-diagnostico só puxa módulos leves (cors, point) — dá pra carregar já.
const { diagnosticar } = exigir("../api/_lib/point-diagnostico.js");

export const AJUDA = [
  "Uso: npm run point:check [-- opções]",
  "",
  "Confere se dá pra cobrar na maquininha: token do Mercado Pago, Firebase,",
  "terminais e modo PDV. Não cobra nada e não mexe em nenhuma venda.",
  "",
  "Opções:",
  "  --terminal <id>   usa esse terminal (id da lista) em vez do MP_POINT_TERMINAL_ID atual",
  "  --gravar          grava o terminal escolhido em MP_POINT_TERMINAL_ID no arquivo .env",
  "                    (escolhe sozinho se a conta tiver um terminal só)",
  "  --colocar-pdv     coloca o terminal escolhido em modo PDV (passa a receber cobranças do sistema)",
  "  --ajuda           mostra este texto"
];

/** argv (sem node e sem o script) → opções. `erro` vem preenchido se houver argumento desconhecido. */
export function lerArgumentos(argv) {
  const r = { terminal: null, gravar: false, colocarPdv: false, ajuda: false, erro: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--gravar") r.gravar = true;
    else if (a === "--colocar-pdv") r.colocarPdv = true;
    else if (a === "--ajuda" || a === "--help" || a === "-h") r.ajuda = true;
    else if (a === "--terminal") {
      const valor = argv[i + 1];
      if (!valor || valor.startsWith("--")) {
        r.erro = "--terminal precisa do id do terminal (ex.: --terminal PAX_A910__SMARTPOS123).";
      } else {
        r.terminal = valor;
        i += 1;
      }
    } else if (a.startsWith("--terminal=")) r.terminal = a.slice("--terminal=".length) || null;
    else r.erro = `Opção desconhecida: ${a}`;
  }
  return r;
}

const MARCA = { ok: "[ OK ]", aviso: "[AVISO]", erro: "[ERRO]" };
const ANSI = { ok: 32, aviso: 33, erro: 31 };

/** Resultado do diagnóstico → linhas de texto. */
export function formatarDiagnostico(r, { cor = false } = {}) {
  const pintar = (nivel, texto) => (cor ? `\x1b[${ANSI[nivel]}m${texto}\x1b[0m` : texto);
  const linhas = [];
  for (const c of r.checks) {
    linhas.push(`${pintar(c.nivel, MARCA[c.nivel])} ${c.titulo}: ${c.detalhe}`);
    if (c.acao) linhas.push(`       -> ${c.acao}`);
  }
  if (r.terminais.length) {
    linhas.push("", "Terminais da conta:");
    for (const t of r.terminais) {
      linhas.push(
        `  ${t.selecionado ? "*" : " "} ${t.id}   modo ${t.modo || "?"}${t.caixa_externo ? `   caixa ${t.caixa_externo}` : ""}${t.selecionado ? "   <- em uso" : ""}`
      );
    }
  }
  const erros = r.checks.filter((c) => c.nivel === "erro").length;
  const avisos = r.checks.filter((c) => c.nivel === "aviso").length;
  linhas.push(
    "",
    r.ok
      ? avisos
        ? `Pronto pra cobrar (com ${avisos} aviso${avisos > 1 ? "s" : ""}).`
        : "Tudo pronto pra cobrar."
      : `Faltam ${erros} ${erros > 1 ? "itens" : "item"} antes de cobrar (os marcados [ERRO]).`
  );
  return linhas;
}

// Qual terminal as opções --gravar / --colocar-pdv devem usar.
function escolherAlvo(r, terminalPedido) {
  const procurar = (id) => r.terminais.find((t) => t.id === id) || null;
  const pedido = terminalPedido || r.configurado;
  if (pedido) {
    const t = procurar(pedido);
    return t ? { terminal: t } : { motivo: `o terminal ${pedido} não está na lista da conta` };
  }
  if (r.terminais.length === 1) return { terminal: r.terminais[0] };
  if (r.terminais.length === 0) return { motivo: "a conta não tem nenhum terminal" };
  return { motivo: `a conta tem ${r.terminais.length} terminais — escolha um com --terminal <id>` };
}

/**
 * @param {object} p
 * @param {string[]} p.argv
 * @param {object} p.env                 variáveis (process.env)
 * @param {object} p.mp                  cliente do Mercado Pago
 * @param {() => Promise<{projectId:string}>} p.checarFirebase
 * @param {string} [p.arquivoEnv]        caminho do .env (onde --gravar escreve)
 * @param {boolean} [p.envCarregado]     se o .env existia
 * @param {(chave:string, valor:string) => void} [p.gravarNoEnv]
 * @param {(linha:string) => void} [p.saida]
 * @param {boolean} [p.cor]
 * @returns {Promise<{codigo:number, resultado?:object}>}
 */
export async function executarCheck({
  argv = [],
  env,
  mp,
  checarFirebase,
  arquivoEnv,
  envCarregado = true,
  gravarNoEnv = (chave, valor) => gravarChaveNoArquivo(arquivoEnv, chave, valor),
  saida = console.log,
  cor = false
}) {
  const args = lerArgumentos(argv);
  if (args.erro) {
    saida(args.erro);
    saida("");
    AJUDA.forEach((l) => saida(l));
    return { codigo: 2 };
  }
  if (args.ajuda) {
    AJUDA.forEach((l) => saida(l));
    return { codigo: 0 };
  }

  if (!envCarregado) {
    saida("Não achei o arquivo .env na raiz do projeto. Copie o .env.example para .env e preencha MP_ACCESS_TOKEN");
    saida("(PowerShell: Copy-Item .env.example .env). Vou conferir com o que estiver no ambiente do terminal.");
    saida("");
  }

  if (args.terminal) env.MP_POINT_TERMINAL_ID = args.terminal; // só nesta execução; --gravar é que persiste

  let r = await diagnosticar({ env, mp, checarFirebase });
  let falhouAcao = false;
  let mudou = false;
  const notas = [];

  if (args.gravar || args.colocarPdv) {
    const alvo = escolherAlvo(r, args.terminal);

    if (args.gravar) {
      if (!alvo.terminal) notas.push(`--gravar: não gravei nada — ${alvo.motivo}.`);
      else if (!envCarregado) {
        notas.push(`--gravar: não gravei — crie o .env primeiro. Depois coloque nele: MP_POINT_TERMINAL_ID=${alvo.terminal.id}`);
      } else {
        gravarNoEnv("MP_POINT_TERMINAL_ID", alvo.terminal.id);
        env.MP_POINT_TERMINAL_ID = alvo.terminal.id;
        notas.push(`--gravar: MP_POINT_TERMINAL_ID=${alvo.terminal.id} gravado no .env.`);
        mudou = true;
      }
    }

    if (args.colocarPdv) {
      if (!alvo.terminal) {
        notas.push(`--colocar-pdv: não mexi em nada — ${alvo.motivo}.`);
      } else if (alvo.terminal.modo === "PDV") {
        notas.push(`--colocar-pdv: ${alvo.terminal.id} já está em modo PDV.`);
      } else {
        try {
          await mp.definirModoTerminal(alvo.terminal.id, "PDV");
          notas.push(
            `--colocar-pdv: ${alvo.terminal.id} agora está em modo PDV — só recebe cobranças do sistema. ` +
              `Pra voltar a funcionar sozinha: Configurações → Maquininha → "Voltar ao modo autônomo". ` +
              `Se ela não mudar em alguns segundos, reinicie a maquininha.`
          );
          mudou = true;
        } catch (erro) {
          falhouAcao = true;
          notas.push(`--colocar-pdv: o Mercado Pago recusou — ${(erro && (erro.publico || erro.message)) || erro}`);
        }
      }
    }
  }

  if (mudou) r = await diagnosticar({ env, mp, checarFirebase });

  formatarDiagnostico(r, { cor }).forEach((l) => saida(l));
  if (notas.length) {
    saida("");
    notas.forEach((n) => saida(n));
  }
  if (r.ok && !falhouAcao) {
    saida("");
    saida("Próximo passo: npm run api:dev  (e, em outro terminal, python scripts/dev_server.py).");
  }
  return { codigo: r.ok && !falhouAcao ? 0 : 1, resultado: r };
}

async function main() {
  const arquivoEnv = path.join(RAIZ, ".env");
  const { carregado } = carregarEnv({ arquivo: arquivoEnv });
  const mp = exigir("../api/_lib/mercadopago.js");
  const { checarFirebase } = exigir("../api/_lib/firebase-admin.js");
  const cor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  const { codigo } = await executarCheck({
    argv: process.argv.slice(2),
    env: process.env,
    mp,
    checarFirebase,
    arquivoEnv,
    envCarregado: carregado,
    cor
  });
  // O gRPC do Firestore pode manter o processo vivo; sai sozinho (com folga pra a saída terminar de escrever).
  process.exitCode = codigo;
  setTimeout(() => process.exit(codigo), 300).unref();
}

const executadoDireto = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  main().catch((erro) => {
    console.error("point:check falhou:", erro && erro.message);
    process.exit(1);
  });
}
