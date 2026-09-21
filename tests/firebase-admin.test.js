const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { credenciais } = require("../api/_lib/firebase-admin");

// Tudo aqui é FALSO: nenhuma credencial real é lida (caminhos e env vão
// injetados, então nem um serviceAccount.json de verdade na máquina de quem
// roda o teste interfere).
const FALSA = {
  type: "service_account",
  project_id: "flora-5754a",
  private_key: "-----BEGIN PRIVATE KEY-----\nSEGREDO-FALSO-DE-TESTE\n-----END PRIVATE KEY-----\n",
  client_email: "teste@flora-5754a.iam.gserviceaccount.com"
};
const json = (o = FALSA) => JSON.stringify(o);
const base64 = (o = FALSA) => Buffer.from(json(o), "utf8").toString("base64");
const SEM_ARQUIVO = []; // nenhum caminho local a tentar

function pastaTemporaria() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amira-sa-"));
}

test("credenciais: lê o JSON cru da env var", () => {
  const c = credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: json() }, caminhos: SEM_ARQUIVO });
  assert.equal(c.project_id, "flora-5754a");
  assert.equal(c.client_email, FALSA.client_email);
});

test("credenciais: aceita a mesma coisa em base64 (evita quebra de linha ao colar no painel)", () => {
  const c = credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: base64() }, caminhos: SEM_ARQUIVO });
  assert.equal(c.project_id, "flora-5754a");
  assert.equal(c.private_key, FALSA.private_key);
});

test("credenciais: '\\n' literal na private_key (colada em uma linha) vira quebra de linha de verdade", () => {
  const umaLinha = { ...FALSA, private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n" };
  const c = credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: json(umaLinha) }, caminhos: SEM_ARQUIVO });
  assert.equal(c.private_key, "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n");
});

test("credenciais: espaços em volta do valor colado não atrapalham", () => {
  const c = credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: `\n  ${json()}  \n` }, caminhos: SEM_ARQUIVO });
  assert.equal(c.project_id, "flora-5754a");
});

test("credenciais: sem env var e sem arquivo → erro que diz o que configurar (inclusive a opção local)", () => {
  assert.throws(
    () => credenciais({ env: {}, caminhos: SEM_ARQUIVO }),
    (e) => /FIREBASE_SERVICE_ACCOUNT/.test(e.message) && /serviceAccount\.json/.test(e.message)
  );
  assert.throws(() => credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: "   " }, caminhos: SEM_ARQUIVO }), /FIREBASE_SERVICE_ACCOUNT/);
});

test("credenciais: JSON quebrado → 'não é um JSON válido', sem vazar o conteúdo", () => {
  assert.throws(
    () => credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: '{"private_key": "SEGREDO-FALSO-DE-TESTE", ' }, caminhos: SEM_ARQUIVO }),
    (e) => /JSON válido/.test(e.message) && !/SEGREDO-FALSO/.test(e.message)
  );
});

test("credenciais: JSON sem project_id / private_key / client_email → 'incompleta'", () => {
  for (const campo of ["project_id", "private_key", "client_email"]) {
    const { [campo]: _, ...faltando } = FALSA;
    assert.throws(
      () => credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: json(faltando) }, caminhos: SEM_ARQUIVO }),
      (e) => /incompleta/.test(e.message) && !/SEGREDO-FALSO/.test(e.message),
      campo
    );
  }
});

test("credenciais (local): sem env var, usa o arquivo do primeiro caminho que existir", () => {
  const dir = pastaTemporaria();
  try {
    const arquivo = path.join(dir, "sa.json");
    fs.writeFileSync(arquivo, json());
    const c = credenciais({ env: {}, caminhos: [path.join(dir, "nao-existe.json"), arquivo] });
    assert.equal(c.project_id, "flora-5754a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credenciais (local): o arquivo também pode estar em base64, igual à env var", () => {
  const dir = pastaTemporaria();
  try {
    const arquivo = path.join(dir, "sa.b64");
    fs.writeFileSync(arquivo, base64());
    assert.equal(credenciais({ env: {}, caminhos: [arquivo] }).client_email, FALSA.client_email);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credenciais (local): a env var tem precedência sobre o arquivo", () => {
  const dir = pastaTemporaria();
  try {
    const arquivo = path.join(dir, "sa.json");
    fs.writeFileSync(arquivo, json({ ...FALSA, project_id: "do-arquivo" }));
    const c = credenciais({ env: { FIREBASE_SERVICE_ACCOUNT: json({ ...FALSA, project_id: "da-env" }) }, caminhos: [arquivo] });
    assert.equal(c.project_id, "da-env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credenciais (local): GOOGLE_APPLICATION_CREDENTIALS vem antes do serviceAccount.json da raiz", () => {
  const dir = pastaTemporaria();
  try {
    const arquivo = path.join(dir, "outra.json");
    fs.writeFileSync(arquivo, json({ ...FALSA, project_id: "do-google-app-cred" }));
    // sem `caminhos`: usa a ordem padrão (env → raiz do repo → cwd)
    const c = credenciais({ env: { GOOGLE_APPLICATION_CREDENTIALS: arquivo } });
    assert.equal(c.project_id, "do-google-app-cred");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credenciais (local): arquivo com lixo vira erro claro em vez de cair no próximo silenciosamente", () => {
  const dir = pastaTemporaria();
  try {
    const arquivo = path.join(dir, "ruim.json");
    fs.writeFileSync(arquivo, "isso nao e json");
    assert.throws(() => credenciais({ env: {}, caminhos: [arquivo] }), /JSON válido/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
