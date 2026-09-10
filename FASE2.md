# Fase 2 — Integrar os pedidos do site

## STATUS (2026-09-10): implementado — falta deploy + teste real

- **Feito:** pagina `pedidos.html` + `pages/pedidos.js` (so admin), item "Pedidos" no
  NAV, helper `derivarItensPedido` em `produtos-schema.js`.
- **Estoque:** opcao **B** — a mudanca de status para pago/preparando/enviado/entregue
  roda transacao que baixa `estoqueVarejo`/`estoqueAtacado` (por `it.modo`) e grava
  `estoqueBaixado:true`. Cancelar pedido baixado devolve o estoque.
- **Exibicao:** so na pagina nova. Painel e Vendas continuam so com a loja fisica
  (decisao do dono).
- **firestore.rules / indexes:** NAO mudaram. O `update` de `pedidos` ja era
  `if ehAdmin()` sem allowlist; a query usa so `orderBy("criadoEm","desc")` + `limit`.
- **Falta:** `firebase deploy --only hosting:interno`; testar um pedido real de ponta a
  ponta (inclusive com `?ref=`); confirmar qual campo o site marca como "pago"
  (`status` vs `pagamento.status`) — a pagina dirige `status`.

## TL;DR

**O site em si quase nao muda.** A captura do `?ref=` e a gravacao do campo `ref` no
pedido **ja estao feitas** (`frontend/src/pages/services/indicacao.js` +
`services/pedidos.js`, aceitas pelas rules). O checkout do site **nao deve** gravar em
`vendas` nem carregar preco — isso e decisao de arquitetura ja fechada.

Quase todo o trabalho da Fase 2 e **no sistema interno** (este repo): telas novas que
leem a colecao `pedidos` e derivam os totais do catalogo, do mesmo jeito que
`pages/indicadores.js` ja faz na apuracao.

A unica mudanca que pode tocar o site e **uma linha na allowlist de `pedidos` no
`firestore.rules`** (que vive aqui, nao no repo do site) — e so se escolhermos a
opcao de baixar estoque pelo sistema (ver "Estoque" abaixo).

---

## O que muda no site

| Item | Precisa mexer no site? |
|---|---|
| Capturar `?ref=`, janela de 7 dias, last-click | **Nao** — `services/indicacao.js` pronto, importado em `services/script.js`. |
| Gravar `ref`/`refEm` no pedido | **Nao** — `services/pedidos.js` `criarPedido` ja anexa se `refAtivo()`. |
| Checkout gravar `vendas` com total | **Nao** — proibido por design (rules rejeitam campo fora da allowlist). |
| Nome/contato do comprador para o sistema ver | **Nao** — o pedido tem `uidComprador`; o admin le `usuarios/{uid}` pelo sistema. |
| Vocabulario de status (`aguardando_pagamento`, `pago`, `preparando`, `enviado`, `entregue`, `cancelado`) | **Nao** — o sistema so precisa usar o mesmo conjunto. |
| Baixa de estoque quando o pedido e pago | **Depende da opcao escolhida** (abaixo). No maximo: +1 chave na allowlist de `pedidos` nas rules deste repo. Zero JS no site. |

---

## O que muda no sistema interno (este repo)

1. **Nova pagina `pedidos.html` + `pages/pedidos.js` (so admin).**
   - Lista `pedidos` (filtro por status e por periodo), ordenado por `criadoEm`.
   - Deriva itens/subtotal/frete/total do catalogo atual — mesma logica de
     `derivarTotaisDePedidos` do site; portar para `produtos-schema.js` ou reimplementar
     enxuto (preco via `infoPreco`, peso, frete opcional).
   - Detalhe do pedido: comprador (`usuarios/{uid}`), endereco, itens, total derivado,
     `ref` do indicador se houver.
   - Botao de mudar status (`updateDoc` — as rules ja permitem `update` de `pedidos`
     para admin).
   - Item no NAV do `ui.js`, so-admin (como `indicadores`).

2. **Dashboard e Vendas passam a incluir o canal `site`.**
   - `pages/dashboard.js` e `pages/vendas.js` hoje so leem a colecao `vendas`
     (canal `loja`). Adicionar leitura de `pedidos` do periodo, derivar totais e somar
     em "vendas por canal" / listar junto com marcador de canal.
   - Alternativa mais simples: manter as telas atuais so com a loja fisica e concentrar
     o site na pagina nova de Pedidos. Decisao do dono.

3. **(Opcional) Persistir a apuracao de indicadores.**
   - Hoje `pages/indicadores.js` so calcula na tela. Fase 2 pode gravar
     `comissoes_indicadores/{AAAA-MM}` com total e flag `pago` (igual ao fluxo de
     comissao de vendedor). So-admin nas rules. Nada no site.

4. **Numeracao amigavel do pedido (opcional).**
   - `pedidos` usa id automatico do Firestore. Se quiser um numero curto, atribuir no
     sistema na primeira vez que o pedido e aberto. Nao mexe no site.

---

## Estoque — a unica decisao de verdade

Site e PDV agora **compartilham `produtos.estoqueVarejo`**. Hoje **nenhum pedido do
site baixa estoque** — so o PDV baixa. Sem tratar isso, site e loja fisica podem
vender a mesma unidade.

| Opcao | Como funciona | Muda o site? | Custo |
|---|---|---|---|
| **A. Manual** | Ao preparar o pedido, o admin ajusta o estoque na tela de Produtos. | Nao | Zero. Serve pra volume baixo. |
| **B. Baixa pelo sistema ao marcar "pago"/"preparando"** (recomendada) | Na pagina nova de Pedidos, o botao de status roda uma transacao que decrementa `estoqueVarejo` dos itens e marca `estoqueBaixado: true` no pedido (evita baixa dupla). | So `firestore.rules` **deste repo**: adicionar `estoqueBaixado`/`estoqueBaixadoEm` a allowlist de `update` de `pedidos` (o `update` ja e so-admin). Nenhum JS do site. | Baixo. Encaixa no modelo custo-zero + conferencia humana. |
| **C. Baixa no site na criacao do pedido** | `criarPedido` decrementa numa transacao. | Sim — `services/pedidos.js` + allowlist de `create`. | Nao recomendada: cliente sem servidor, da pra burlar; e reserva estoque de pedido que pode nao ser pago. |

Recomendacao: **B**. Reversao de estoque (pedido cancelado depois de pago) reaproveita
a logica de `pages/vendas.js` `cancelar()`.

---

## Passo a passo sugerido

1. Definir com o dono: opcao de estoque (A ou B) e se Dashboard/Vendas mostram o site
   ou so a pagina nova.
2. Se opcao B: editar a allowlist de `pedidos` em `firestore.rules` (+2 chaves) e
   `firestore.indexes.json` se precisar de indice `pedidos (status, criadoEm)`.
3. Implementar `pedidos.html` + `pages/pedidos.js` + item no NAV.
4. Portar a derivacao de totais (reaproveitar de `indicadores.js` / do site).
5. (Se decidido) somar o canal `site` no dashboard e nas vendas.
6. Deploy junto: `firestore:rules,firestore:indexes` (deste repo) + `hosting:interno`.
7. Testar com um pedido real do site de ponta a ponta (incluindo com `?ref=`).

Nada disso exige backend novo nem sai do plano Spark.
