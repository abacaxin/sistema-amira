# Sistema interno Amira

Sistema de gestao da perfumaria Amira: login de ADM e vendedor, PDV com leitor de
codigo de barras, caixa diario, comissionamento, cadastro de produtos, apuracao de
indicadores (link `?ref=` do site) e painel. Fases futuras: consumir os pedidos do
site proprio, Mercado Livre, Shopee e conciliacao com o Mercado Pago.

**Stack:** HTML + CSS + JavaScript puro (ES modules), Firebase Web SDK **10.12.5**
(Auth + Firestore), Firebase Hosting. Scripts Python (`firebase-admin`) para bootstrap,
importacao de catalogo, relatorios e backup.

Roda **100% no plano gratuito (Spark)** do Firebase. **Nenhuma Cloud Function.** Toda
automacao e script Python + GitHub Actions (cron).

---

## 0. Unificacao com o site (importante)

Desde 2026-09 o sistema **compartilha o projeto Firebase do site** (`flora-5754a`) e o
**mesmo catalogo `produtos`**. Consequencias:

| Tema | Como e |
|---|---|
| Projeto Firebase | `flora-5754a` (o mesmo do site). O sistema e um **app separado** neste repo, publicado num alvo de Hosting proprio (`interno` -> `https://flora-5754a-interno.web.app`). |
| Regras e indices | `firestore.rules` e `firestore.indexes.json` **deste repo sao os canonicos** (cobrem site + sistema). **Deploy de regras/indices sai daqui, nunca do repo do site.** A copia em `~/Documentos/Amira/` e so referencia. |
| Papel de admin | `role: "admin"` no doc `usuarios/{uid}` (igual ao site). O outro papel e `role: "vendedor"`. |
| Schema de produto | E o schema do SITE: `codigoBarras`, `precoVarejo`/`precoAtacado` (dois valores), `estoque` (um so, sem separacao varejo/atacado), `filtros{}` por camada, `ativo`, `descontoAtivo`/`descontoPercentual`, etc. Ver secao 8. |
| "Indicador" x "Revendedor" | Aqui, **indicador** = divulgador com link `?ref=` (colecao `indicadores`, sem login). No site, "revendedor" e outra coisa: comprador atacado com CNPJ (`usuarios.tipoConta == "revendedor"`). Nao confundir. |
| Vendas do site | Ficam na colecao `pedidos` (criada pelo cliente no site, **sem valores monetarios** por design). O sistema **le e deriva** os totais do catalogo. Nao gravamos `pedidos` com preco e o checkout do site **nao** grava em `vendas`. |
| App Check | O site tem App Check (reCAPTCHA v3) mas hoje **desligado** (chave placeholder). Quando ligar o Enforce, este app precisa registrar o proprio App Check no dominio `flora-5754a-interno`. |

---

## 1. O que ja esta pronto

| Modulo | Papel | Descricao |
|---|---|---|
| Login / guarda de rota | — | Firebase Auth (e-mail/senha). So `admin` ou `vendedor` ativo entram; cliente do site que tentar logar e deslogado no submit com aviso. |
| Painel (`dashboard`) | admin + vendedor | Vendas do dia, faturamento, ticket medio, comissao do mes, caixa aberto (unico pra loja toda), vendas por canal, top produtos. Vendedor ve so os proprios numeros de venda; comissao e caixa sao compartilhados. |
| PDV (`pdv`) | admin + vendedor | **Leitor USB de codigo de barras** (bipa `codigoBarras` -> carrinho) + busca por nome. Preco via `infoPreco`, estoque via `estoquePorModo` (pool unico, sem separacao varejo/atacado). Carrinho, cliente/contato obrigatorios, desconto, formas de pagamento, baixa de `estoque`, calculo de comissao e vinculo ao caixa **unico/compartilhado** — tudo numa transacao. Recibo para impressao. |
| Caixa (`caixa`) | admin + vendedor | Caixa **unico pra loja toda** (nao "do usuario") — so pode haver um aberto por vez, qualquer staff opera nele (abre, lanca sangria/suprimento, fecha), conferencia soma vendas de toda a equipe. Fechamento com conferencia de dinheiro e divergencia, historico compartilhado. |
| Vendas (`vendas`) | admin + vendedor | Historico com filtro por canal e por forma de pagamento. Admin pode cancelar venda (devolve `estoque` em transacao). Vendedor ve as proprias vendas de loja + o espelho de pedidos do site. |
| Comissoes (`comissoes`) | admin + vendedor | Relatorio por vendedor/periodo (so canal `loja`), fechamento de periodo e marcacao de pago. |
| Produtos (`produtos`) | **so admin** | Editor completo no schema do site: `codigoBarras` (EAN) obrigatorio e unico, `filtros{}` por camada + categoria legado, precos varejo/atacado, estoques, desconto, `ativo`/`destaque`/`freteDisponivel`; fotos por URL. Acao em massa ativar/inativar. |
| Indicadores (`indicadores`) | **so admin** | CRUD de indicadores (`nome, codigo, contato, ativo`), copia do link `?ref=`, e **apuracao por periodo**: le `pedidos` com `ref`, deriva a base elegivel do catalogo atual (`camadas` + `produtos`), exclui iPhone, aplica o percentual. Pagamento manual. |
| Usuarios (`usuarios`) | **so admin** | Cria vendedor **sem deslogar o admin** (instancia secundaria do Firebase App so para o `createUserWithEmailAndPassword`; o doc `usuarios/{uid}` e gravado pela instancia primaria). Define `%`/base de comissao, ativa/inativa. |
| Configuracoes (`config`) | **so admin** | `configuracoes/sistema` (nome da loja, CNPJ, formas de pagamento, base + `%` padrao de comissao) e `configuracoes/indicadores` (`site_url`, `percentual`, `janela_dias`, `categorias_excluidas[]`). |
| Backup | — | GitHub Action diaria exporta o Firestore para JSON (artefato de 30 dias). |

### Estado (2026-09)

- Regras, indices e Hosting **ja publicados** em `flora-5754a`. URL:
  `https://flora-5754a-interno.web.app`.
- Testado de verdade pela primeira vez em 05/09; bugs de permissao do Firestore
  (abrir caixa, query de vendas do vendedor, cliente do site logando) corrigidos e
  redeployados. Todas as telas de carregamento tem `try/catch` + cartao de erro com
  "Tentar de novo".
- Tema repaletado para **bordo/vinho** (marca da loja) e logo da Amira na sidebar.

### Fases seguintes (nao implementadas)

- **Fase 2 — pedidos do site:** telas no sistema para listar/gerir os `pedidos` do
  site (o site ja captura `?ref=` e grava `ref` no pedido). Ver `FASE2.md`.
- **Fase 3 — Mercado Livre** e **Fase 4 — Shopee:** exigem um backend hospedado fora
  do Spark (ex.: Render free) para OAuth + webhook. Sem app de desenvolvedor ainda.
- **Mercado Pago:** conciliacao real via API — tambem exige backend externo.

---

## 2. Pre-requisitos

- Node.js 18+ e o Firebase CLI (`npm install -g firebase-tools`, ou `npx firebase-tools`).
- Python 3.11+.
- Acesso a conta Google com permissao no projeto `flora-5754a`.

---

## 3. Configurar (uma vez)

1. `public/assets/js/firebase-config.js` — ja contem as credenciais publicas reais do
   `flora-5754a`. So mexer se o app da Web for recriado no Console.
2. `.firebaserc` — ja aponta para `flora-5754a` com o target de Hosting `interno`
   (`flora-5754a-interno`).
3. `serviceAccount.json` na raiz — chave privada (Console > Configuracoes do projeto >
   Contas de servico). Esta no `.gitignore`; **nao versionar**.
4. No Console do `flora-5754a`: **Authentication > Sign-in method** com **E-mail/senha**
   habilitado; **Firestore** ja existe (e o do site).

---

## 4. Publicar

```bash
firebase login   # ou: npx firebase-tools login

# regras + indices — CANONICO, so a partir DESTE repo, junto com o deploy do site
firebase deploy --only firestore:rules,firestore:indexes

# front-end do sistema (nao afeta o site)
firebase deploy --only hosting:interno
```

> O Console pode oferecer um link "criar indice" na primeira vez que uma tela roda
> uma query composta nova — basta clicar.

---

## 5. Criar o primeiro admin

```bash
cd scripts
python -m venv .venv && source .venv/bin/activate      # opcional
pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS=../serviceAccount.json

python bootstrap_admin.py --email "dono@amira.com" --senha "trocar-depois" --nome "Dono"
```

Cria o usuario no Auth, o doc `usuarios/{uid}` com `role: "admin"` e os docs
`configuracoes/sistema` e `configuracoes/indicadores` padrao. Depois e so acessar
`https://flora-5754a-interno.web.app` e logar.

---

## 6. Uso no dia a dia

- **Admin** cria os vendedores em **Usuarios** (senha provisoria; redefinir depois no
  Console ou via "Esqueci a senha", se habilitado).
- **Configuracoes**: base da comissao (`total`, `total_sem_desconto` ou `margem`) e o
  `%` padrao. Cada vendedor pode ter override em **Usuarios**. Obs.: base `margem` fica
  0 enquanto o catalogo do site nao tiver campo de custo.
- **Vendedor** abre o **Caixa** no inicio do dia, vende no **PDV**, fecha o caixa
  conferindo o dinheiro no fim do dia.
- **Comissoes**: no fim do mes o admin fecha o periodo por vendedor e marca como pago.
- **Indicadores**: o admin apura o periodo, exporta e paga manualmente.

### Scripts

```bash
# importar / atualizar catalogo (CSV ou XLSX) — upsert por codigoBarras, schema do site
python scripts/importar_produtos.py --arquivo scripts/exemplo_produtos.csv

# comissoes de vendedores do mes -> XLSX
python scripts/relatorio_comissoes.py --periodo 2026-09

# comissoes dos indicadores (link ?ref= do site) -> XLSX
python scripts/relatorio_indicadores.py --periodo 2026-09

# backup manual do Firestore
python scripts/backup_firestore.py --dir backups

# servidor estatico local para abrir o front sem deploy
python scripts/dev_server.py
```

### Backup automatico (GitHub Actions)

Se versionar no GitHub, adicione o secret `FIREBASE_SERVICE_ACCOUNT` (conteudo do
`serviceAccount.json`) em **Settings > Secrets and variables > Actions**. O workflow
`.github/workflows/backup.yml` roda diariamente e guarda o backup como artefato (30 dias).

---

## 7. Estrutura

```
public/                       front-end (deploy no Hosting, target "interno")
  *.html                      uma pagina por modulo
  assets/css/base.css         estilo unico (paleta bordo/vinho)
  assets/img/amira-logo.png   logo da sidebar
  assets/js/
    firebase-config.js        credenciais publicas do flora-5754a
    firebase.js               init do SDK (10.12.5)
    auth.js                   login, guarda de rota (ehEquipe), criar vendedor
    db.js                     re-export do Firestore + helpers de data/config
    ui.js                     shell (menu), toast, modal, erroCard
    money.js                  formatacao/arredondamento
    regras.js                 calculo de comissao de vendedor
    produtos-schema.js        helpers portados do site (infoPreco, estoquePorModo,
                              slugEhIphone, baseElegivelIndicador, ...)
    camadas.js                servico de camadas (filtros do catalogo)
    pages/*.js                logica de cada tela
scripts/                      ferramentas Python (firebase-admin)
firestore.rules               CANONICO (site + sistema)
firestore.indexes.json        CANONICO
firebase.json                 Hosting (target "interno") + Firestore
.firebaserc                   projeto flora-5754a + target interno
```

---

## 8. Modelo de dados (Firestore)

Colecoes **do sistema**:

- `usuarios/{uid}`: `nome, email, role ("admin"|"vendedor"), ativo, comissao{ base?, percentual? }`
  (o mesmo doc que o site usa para clientes; papel de equipe so o admin grava).
- `configuracoes/sistema`: `nome_loja, cnpj, formas_pagamento[], comissao{ base, percentual_padrao }`.
- `configuracoes/indicadores`: `site_url, percentual, janela_dias, categorias_excluidas[]`.
- `indicadores/{id}`: `nome, codigo, contato, ativo`. `codigo` = valor do `?ref=`.
- `vendas/{id}`: venda da **loja fisica**. `numero, canal ("loja"), data, vendedor_uid,
  vendedor_nome, itens[], subtotal, desconto, total, pagamentos[], status, caixa_id,
  comissao{ base, percentual, valor, status }`.
- `caixa/{id}`: `data, aberto_por_uid, valor_abertura, movimentos[], status,
  valor_fechamento_informado, resumo{}`.
- `contadores/vendas`: `ultimo_numero` (numeracao sequencial das vendas da loja).
- `comissoes/{AAAA-MM}/vendedores/{uid}`: consolidado do periodo.
- `integracoes/{canal}`: tokens de marketplace (Fase 3+; `read, write: if false` — so
  o backend Admin SDK).

Colecoes **do site** que o sistema consome:

- `produtos/{id}`: `nome, codigoBarras, categoria (slug legado), filtros{ camadaSlug: [...] },
  precoVarejo, precoAtacado, estoque (pool unico, sem separacao varejo/atacado),
  ativo (bool), descontoAtivo, descontoPercentual, imagemURL, peso, descricao, destaque,
  freteDisponivel`. Helpers: `infoPreco(p, modo)`, `estoquePorModo(p)`.
- `camadas/{id}`: `nome, slug, ordem, opcoes[]` (a camada de `ordem` 1 e a principal;
  iPhone = opcao cujo slug comeca com "iphone").
- `pedidos/{id}`: pedido do site, criado pelo cliente. **Sem valores monetarios.**
  `uidComprador, itens: [{produtoId, quantidade, modo}], temItemAtacado, modoEntrega
  ("entrega"|"retirada"), endereco | null, status, pagamento{ metodo, status }, criadoEm`
  + opcionais `ref` (codigo do indicador) e `refEm`. Totais sao **derivados** do catalogo.

---

## 9. Notas de seguranca

- O front-end usa so a config publica; o controle real esta nas **Security Rules**.
- Vendedor le a propria comissao (nao a dos colegas), mas caixa e vendas sao
  **compartilhados** (o caixa e unico pra loja toda) e `pedidos`/`usuarios` do
  site tambem sao legiveis por vendedor (precisa pra tela de Pedidos —
  confirmar retirada/entrega e ver nome/telefone do comprador).
- Um vendedor ativo so pode alterar `estoque`/`atualizadoEm` em `produtos`
  (baixa do PDV) — nada mais. Estoque e um pool unico (sem separacao
  varejo/atacado); so o preco continua tendo dois valores.
- `integracoes/*` sem leitura/escrita pelo cliente (`if false`) — reservado ao backend
  das fases 3/4.
- **Deploy de `firestore.rules`/`firestore.indexes.json` so a partir deste repo.**
  Publicar a copia do repo do site sobrescreve o que o sistema precisa.
