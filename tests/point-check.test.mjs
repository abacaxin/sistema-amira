import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { executarCheck, lerArgumentos, formatarDiagnostico, AJUDA } from "../scripts/point-check.mjs";

const { criarMpFalso } = createRequire(import.meta.url)("./helpers/fakes.js");

const TERMINAL = "PAX_A910__SMARTPOS123";
const OUTRO = "NEWLAND_N950__N950X";
const ENV_BASE = { MP_ACCESS_TOKEN: "APP_USR-SEGREDO-DO-TOKEN", MP_WEBHOOK_SECRET: "SEGREDO-DO-WEBHOOK" };
const firebaseOk = async () => ({ projectId: "flora-5754a" });

// Ambiente de teste: mp falso que "lembra" o modo, .env em memória, saída capturada.
function montar({ env = {}, terminais = [{ id: TERMINAL, operating_mode: "PDV", store_id: 1, pos_id: 2, external_pos_id: "CX1" }], envCarregado = true, checarFirebase = firebaseOk } = {}) {
  const mp = criarMpFalso();
  mp.terminaisMp = terminais;
  mp.definirModoTerminal = async (id, modo) => {
    mp.chamadas.push(["modo", id, modo]);
    if (mp.falhas.modo) {
      const e = mp.falhas.modo;
      delete mp.falhas.modo;
      throw e;
    }
    mp.terminaisMp.find((t) => t.id === id).operating_mode = modo;
  };
  const linhas = [];
  const gravacoes = [];
  const ambiente = { ...ENV_BASE, ...env };
  const rodar = (argv = []) =>
    executarCheck({
      argv,
      env: ambiente,
      mp,
      checarFirebase,
      arquivoEnv: ".env",
      envCarregado,
      gravarNoEnv: (chave, valor) => gravacoes.push([chave, valor]),
      saida: (l) => linhas.push(l)
    });
  return { mp, linhas, gravacoes, ambiente, rodar, texto: () => linhas.join("\n") };
}

// ── lerArgumentos ──
test("lerArgumentos: sem argumentos tudo desligado; flags e as duas formas de --terminal", () => {
  assert.deepEqual(lerArgumentos([]), { terminal: null, gravar: false, colocarPdv: false, ajuda: false, erro: null });
  assert.equal(lerArgumentos(["--gravar", "--colocar-pdv"]).gravar, true);
  assert.equal(lerArgumentos(["--gravar", "--colocar-pdv"]).colocarPdv, true);
  assert.equal(lerArgumentos(["--terminal", TERMINAL]).terminal, TERMINAL);
  assert.equal(lerArgumentos([`--terminal=${TERMINAL}`]).terminal, TERMINAL);
  assert.equal(lerArgumentos(["--ajuda"]).ajuda, true);
  assert.equal(lerArgumentos(["-h"]).ajuda, true);
});

test("lerArgumentos: opção desconhecida e --terminal sem valor viram erro", () => {
  assert.match(lerArgumentos(["--banana"]).erro, /desconhecida: --banana/);
  assert.match(lerArgumentos(["--terminal"]).erro, /precisa do id/);
  assert.match(lerArgumentos(["--terminal", "--gravar"]).erro, /precisa do id/);
});

// ── formatarDiagnostico ──
test("formatarDiagnostico: marca cada nível, mostra a ação e lista terminais (sem cor por padrão)", () => {
  const linhas = formatarDiagnostico({
    ok: false,
    checks: [
      { id: "a", nivel: "ok", titulo: "Token", detalhe: "Válido" },
      { id: "b", nivel: "aviso", titulo: "Webhook", detalhe: "Sem segredo", acao: "Opcional" },
      { id: "c", nivel: "erro", titulo: "Firebase", detalhe: "Faltou", acao: "Configure X" }
    ],
    terminais: [{ id: TERMINAL, modo: "PDV", caixa_externo: "CX1", selecionado: true }, { id: OUTRO, modo: null, caixa_externo: null, selecionado: false }]
  });
  const t = linhas.join("\n");
  assert.match(t, /\[ OK \] Token: Válido/);
  assert.match(t, /\[AVISO\] Webhook: Sem segredo\n\s+-> Opcional/);
  assert.match(t, /\[ERRO\] Firebase: Faltou\n\s+-> Configure X/);
  assert.match(t, new RegExp(`\\* ${TERMINAL}\\s+modo PDV\\s+caixa CX1\\s+<- em uso`));
  assert.match(t, new RegExp(`  ${OUTRO}\\s+modo \\?`));
  assert.match(t, /Faltam 1 item antes de cobrar/);
  assert.equal(t.includes("\x1b["), false);
});

test("formatarDiagnostico: com cor usa ANSI; resumo muda conforme erros/avisos", () => {
  const ok = { ok: true, checks: [{ id: "a", nivel: "ok", titulo: "T", detalhe: "d" }], terminais: [] };
  assert.ok(formatarDiagnostico(ok, { cor: true }).join("\n").includes("\x1b[32m"));
  assert.match(formatarDiagnostico(ok).join("\n"), /Tudo pronto pra cobrar\./);

  const comAviso = { ok: true, checks: [{ id: "a", nivel: "aviso", titulo: "T", detalhe: "d" }], terminais: [] };
  assert.match(formatarDiagnostico(comAviso).join("\n"), /Pronto pra cobrar \(com 1 aviso\)/);

  const doisErros = { ok: false, checks: [{ id: "a", nivel: "erro", titulo: "T", detalhe: "d" }, { id: "b", nivel: "erro", titulo: "U", detalhe: "d" }], terminais: [] };
  assert.match(formatarDiagnostico(doisErros).join("\n"), /Faltam 2 itens/);
});

// ── executarCheck ──
test("tudo certo: código 0, resumo positivo e o próximo passo; nenhum segredo na saída", async () => {
  const { rodar, texto } = montar({ env: { MP_POINT_TERMINAL_ID: TERMINAL } });
  const r = await rodar();
  assert.equal(r.codigo, 0);
  assert.match(texto(), /Tudo pronto pra cobrar/);
  assert.match(texto(), /npm run api:dev/);
  assert.match(texto(), /LOJA_AMIRA/);
  assert.equal(/SEGREDO/.test(texto()), false);
});

test("sem token: código 1 com o passo a passo, sem consultar o Mercado Pago", async () => {
  const { rodar, texto, mp } = montar({ env: { MP_ACCESS_TOKEN: "", MP_POINT_TERMINAL_ID: TERMINAL } });
  const r = await rodar();
  assert.equal(r.codigo, 1);
  assert.match(texto(), /\[ERRO\] Access Token/);
  assert.match(texto(), /Credenciais de produção/);
  assert.equal(mp.chamadas.length, 0);
  assert.equal(texto().includes("npm run api:dev"), false, "não sugere o próximo passo com erro pendente");
});

test("sem .env: avisa como criar, mas ainda confere o que estiver no ambiente", async () => {
  const { rodar, texto } = montar({ envCarregado: false, env: { MP_POINT_TERMINAL_ID: TERMINAL } });
  const r = await rodar();
  assert.match(texto(), /Não achei o arquivo \.env/);
  assert.match(texto(), /Copy-Item \.env\.example \.env/);
  assert.equal(r.codigo, 0);
});

test("--gravar com um terminal só: grava no .env, passa a valer na mesma execução e o resultado final reflete", async () => {
  const { rodar, texto, gravacoes, ambiente } = montar();
  const r = await rodar(["--gravar"]);
  assert.deepEqual(gravacoes, [["MP_POINT_TERMINAL_ID", TERMINAL]]);
  assert.equal(ambiente.MP_POINT_TERMINAL_ID, TERMINAL);
  assert.match(texto(), new RegExp(`--gravar: MP_POINT_TERMINAL_ID=${TERMINAL} gravado no \\.env`));
  assert.match(texto(), /\[ OK \] Terminal desta loja/);
  assert.equal(r.codigo, 0);
});

test("--gravar com vários terminais e nenhum escolhido: não grava e manda usar --terminal", async () => {
  const { rodar, texto, gravacoes } = montar({
    terminais: [{ id: TERMINAL, operating_mode: "PDV" }, { id: OUTRO, operating_mode: "STANDALONE" }]
  });
  const r = await rodar(["--gravar"]);
  assert.deepEqual(gravacoes, []);
  assert.match(texto(), /não gravei nada — a conta tem 2 terminais — escolha um com --terminal <id>/);
  assert.equal(r.codigo, 1, "continua faltando o terminal");
});

test("--terminal escolhe entre vários e --gravar persiste só esse", async () => {
  const { rodar, gravacoes } = montar({
    terminais: [{ id: TERMINAL, operating_mode: "PDV" }, { id: OUTRO, operating_mode: "PDV" }]
  });
  const r = await rodar(["--terminal", OUTRO, "--gravar"]);
  assert.deepEqual(gravacoes, [["MP_POINT_TERMINAL_ID", OUTRO]]);
  assert.equal(r.codigo, 0);
});

test("--terminal que não existe na conta: não grava, explica e sai com erro", async () => {
  const { rodar, texto, gravacoes } = montar();
  const r = await rodar(["--terminal", "ERRADO__0", "--gravar"]);
  assert.deepEqual(gravacoes, []);
  assert.match(texto(), /o terminal ERRADO__0 não está na lista da conta/);
  assert.equal(r.codigo, 1);
});

test("--gravar sem .env: não cria arquivo sozinho, diz o que colocar", async () => {
  const { rodar, texto, gravacoes } = montar({ envCarregado: false });
  await rodar(["--gravar"]);
  assert.deepEqual(gravacoes, []);
  assert.match(texto(), new RegExp(`crie o \\.env primeiro\\. Depois coloque nele: MP_POINT_TERMINAL_ID=${TERMINAL}`));
});

test("--colocar-pdv: terminal autônomo vai pra PDV, o diagnóstico final fica verde e o aviso de volta aparece", async () => {
  const { rodar, texto, mp } = montar({
    env: { MP_POINT_TERMINAL_ID: TERMINAL },
    terminais: [{ id: TERMINAL, operating_mode: "STANDALONE", store_id: 1, pos_id: 2 }]
  });
  const r = await rodar(["--colocar-pdv"]);
  assert.deepEqual(mp.chamadas.find((c) => c[0] === "modo").slice(1), [TERMINAL, "PDV"]);
  assert.match(texto(), /agora está em modo PDV/);
  assert.match(texto(), /Voltar ao modo autônomo/);
  assert.match(texto(), /reinicie a maquininha/);
  assert.match(texto(), /está em modo PDV — pronto pra receber cobranças/, "o diagnóstico é refeito depois da mudança");
  assert.equal(r.codigo, 0);
});

test("--colocar-pdv: já em PDV não chama o Mercado Pago de novo", async () => {
  const { rodar, texto, mp } = montar({ env: { MP_POINT_TERMINAL_ID: TERMINAL } });
  await rodar(["--colocar-pdv"]);
  assert.equal(mp.quantas("modo"), 0);
  assert.match(texto(), /já está em modo PDV/);
});

test("--colocar-pdv: se o Mercado Pago recusar, mostra o motivo e sai com erro", async () => {
  const { rodar, texto, mp } = montar({
    env: { MP_POINT_TERMINAL_ID: TERMINAL },
    terminais: [{ id: TERMINAL, operating_mode: "STANDALONE" }]
  });
  mp.falhas.modo = Object.assign(new Error("x"), { publico: "O Mercado Pago recusou a requisição: terminal offline" });
  const r = await rodar(["--colocar-pdv"]);
  assert.match(texto(), /o Mercado Pago recusou — O Mercado Pago recusou a requisição: terminal offline/);
  assert.equal(r.codigo, 1);
});

test("--gravar --colocar-pdv juntos (o caminho do primeiro dia): grava, coloca em PDV e termina verde", async () => {
  const { rodar, gravacoes, mp } = montar({ terminais: [{ id: TERMINAL, operating_mode: "STANDALONE" }] });
  const r = await rodar(["--gravar", "--colocar-pdv"]);
  assert.deepEqual(gravacoes, [["MP_POINT_TERMINAL_ID", TERMINAL]]);
  assert.equal(mp.quantas("modo"), 1);
  assert.equal(r.codigo, 0);
});

test("argumento desconhecido: código 2 com a ajuda; --ajuda: código 0; nada é consultado", async () => {
  const a = montar();
  assert.equal((await a.rodar(["--banana"])).codigo, 2);
  assert.match(a.texto(), /Opção desconhecida: --banana/);
  assert.match(a.texto(), /Uso: npm run point:check/);
  assert.equal(a.mp.chamadas.length, 0);

  const b = montar();
  assert.equal((await b.rodar(["--ajuda"])).codigo, 0);
  assert.equal(b.linhas.length, AJUDA.length);
});

test("nenhuma saída jamais contém o valor do token nem do segredo do webhook", async () => {
  for (const argv of [[], ["--gravar"], ["--colocar-pdv"], ["--terminal", "ERRADO__0"], ["--ajuda"], ["--banana"]]) {
    const { rodar, texto } = montar({ terminais: [{ id: TERMINAL, operating_mode: "STANDALONE" }] });
    await rodar(argv);
    assert.equal(/SEGREDO/.test(texto()), false, `argv ${JSON.stringify(argv)}`);
  }
});
