import test from "node:test";
import assert from "node:assert/strict";
import { parsearEnv, carregarEnv, gravarChave, gravarChaveNoArquivo } from "../scripts/lib/env.mjs";

test("parsearEnv: comentários, linhas em branco, export, espaços e CRLF", () => {
  const env = parsearEnv(
    ["# comentário", "", "A=1", "  B = dois  ", "export C=tres", "  # outro comentário", "lixo sem igual", "D="].join("\r\n")
  );
  assert.deepEqual(env, { A: "1", B: "dois", C: "tres", D: "" });
});

test("parsearEnv: valor com '=' no meio (base64 termina em ==) e '#' sem espaço antes fica intacto", () => {
  const env = parsearEnv("TOKEN=abc==\nURL=http://x/#/rota\nSENHA=ab#cd");
  assert.equal(env.TOKEN, "abc==");
  assert.equal(env.URL, "http://x/#/rota");
  assert.equal(env.SENHA, "ab#cd");
});

test("parsearEnv: ' # comentário' no fim da linha é descartado quando não há aspas", () => {
  assert.equal(parsearEnv("A=valor # anotação").A, "valor");
  assert.equal(parsearEnv("A=valor\t# anotação").A, "valor");
});

test("parsearEnv: aspas protegem espaço e '#'; o JSON da service account cabe entre aspas simples", () => {
  const json = '{"type":"service_account","project_id":"flora-5754a","private_key":"-----BEGIN-----\\nX\\n-----END-----\\n"}';
  const env = parsearEnv(`A="com espaço # e hash"\nB='outro # valor'\nFIREBASE_SERVICE_ACCOUNT='${json}' # colado do arquivo\nC="fim" # nota`);
  assert.equal(env.A, "com espaço # e hash");
  assert.equal(env.B, "outro # valor");
  assert.equal(env.FIREBASE_SERVICE_ACCOUNT, json);
  assert.equal(env.C, "fim");
});

test("parsearEnv: entradas estranhas não estouram", () => {
  assert.deepEqual(parsearEnv(""), {});
  assert.deepEqual(parsearEnv(undefined), {});
  assert.deepEqual(parsearEnv(null), {});
  assert.deepEqual(parsearEnv("1INVALIDO=x\n=sem-nome"), {});
});

test("carregarEnv: não sobrescreve o que já está no ambiente; só devolve os NOMES das chaves lidas", () => {
  const env = { MP_ACCESS_TOKEN: "do-terminal", VAZIA: "" };
  const r = carregarEnv({
    arquivo: ".env",
    env,
    ler: () => "MP_ACCESS_TOKEN=do-arquivo\nMP_POINT_TERMINAL_ID=PAX__1\nVAZIA=preenchida\n"
  });
  assert.equal(r.carregado, true);
  assert.equal(env.MP_ACCESS_TOKEN, "do-terminal", "variável já definida manda mais que o arquivo");
  assert.equal(env.MP_POINT_TERMINAL_ID, "PAX__1");
  assert.equal(env.VAZIA, "preenchida", "variável vazia no ambiente não conta como definida");
  assert.deepEqual(r.chaves.sort(), ["MP_POINT_TERMINAL_ID", "VAZIA"]);
  assert.equal(JSON.stringify(r).includes("do-arquivo"), false, "o retorno não carrega valores");
});

test("carregarEnv: arquivo inexistente não é erro", () => {
  const env = {};
  const r = carregarEnv({
    arquivo: "nao-existe",
    env,
    ler: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  assert.deepEqual(r, { carregado: false, chaves: [] });
  assert.deepEqual(env, {});
});

test("gravarChave: troca a linha existente e preserva o resto (comentários, ordem, CRLF)", () => {
  const antes = ["# tokens", "MP_ACCESS_TOKEN=segredo", "MP_POINT_TERMINAL_ID=", "MP_WEBHOOK_SECRET=x", ""].join("\r\n");
  const depois = gravarChave(antes, "MP_POINT_TERMINAL_ID", "PAX_A910__SMARTPOS1");
  assert.equal(depois, ["# tokens", "MP_ACCESS_TOKEN=segredo", "MP_POINT_TERMINAL_ID=PAX_A910__SMARTPOS1", "MP_WEBHOOK_SECRET=x", ""].join("\r\n"));
});

test("gravarChave: acrescenta no fim se a chave não existe (com ou sem quebra final) e ignora linha comentada", () => {
  assert.equal(gravarChave("A=1\n", "B", "2"), "A=1\nB=2\n");
  assert.equal(gravarChave("A=1", "B", "2"), "A=1\nB=2\n");
  assert.equal(gravarChave("", "B", "2"), "B=2\n");
  assert.equal(gravarChave("# B=velho\nA=1\n", "B", "2"), "# B=velho\nA=1\nB=2\n", "não mexe na linha comentada");
});

test("gravarChave: só a primeira ocorrência ativa é trocada, e 'export' é respeitado", () => {
  assert.equal(gravarChave("export B=1\nB=9\n", "B", "2"), "B=2\nB=9\n");
});

test("gravarChave: recusa nome inválido e valor com quebra de linha", () => {
  assert.throws(() => gravarChave("", "1ruim", "x"), /inválido/);
  assert.throws(() => gravarChave("", "A B", "x"), /inválido/);
  assert.throws(() => gravarChave("", "A", "x\ny"), /quebra de linha/);
});

test("gravarChave: valor com '$' e '&' não é interpretado (nada de regex/replace no valor)", () => {
  assert.equal(gravarChave("A=1\n", "A", "$&-$1"), "A=$&-$1\n");
});

test("gravarChaveNoArquivo: lê, troca e escreve; cria o arquivo se não existir", () => {
  const disco = new Map([[".env", "A=1\nB=\n"]]);
  const io = {
    ler: (c) => {
      if (!disco.has(c)) throw new Error("ENOENT");
      return disco.get(c);
    },
    escrever: (c, t) => disco.set(c, t)
  };
  gravarChaveNoArquivo(".env", "B", "dois", io);
  assert.equal(disco.get(".env"), "A=1\nB=dois\n");
  gravarChaveNoArquivo("novo.env", "C", "3", io);
  assert.equal(disco.get("novo.env"), "C=3\n");
});
