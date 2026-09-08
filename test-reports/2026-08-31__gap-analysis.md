# Análise de gaps de detecção — traceability-agent

**Data:** 2026-08-31
**Grupo de teste:** `repo-testes` (6 repositórios fixture em `~/projetos/rePo_testes/`)
**Objetivo:** validar que o agente detecta corretamente integrações quebradas em qualquer
ponto de uma cadeia de dependências (início, meio, fim) e que o cascateamento de impacto
não deixa gaps — incluindo o caso de uma dependência de artefato (`published_artifact_dependency`)
apontando para um repositório que está com problema por causa de uma integração *diferente*.

## Topologia usada nos testes

```
order-service --(kafka: orders.created)--> fulfillment-service --(kafka: fulfillment.completed)--> analytics-service --(kafka: analytics.processed)--> reporting-service

billing-service --(maven dependency)--> shared-utils        [ponto de controle saudável, sem integrações próprias]
billing-service --(maven dependency, cross-ecossistema)--> fulfillment-service
```

- `order-service` (Java/Maven) publica via Kafka, `fulfillment-service` (Kotlin/Gradle) consome via `@SqsListener` (cross-tecnologia, casado pelo nome do tópico).
- `fulfillment-service` publica `fulfillment.completed`, `analytics-service` (Node/TS) consome e republica `analytics.processed`.
- `reporting-service` (Java/Maven) consome `analytics.processed` via `@KafkaListener`.
- `billing-service` (Java/Maven) tem duas dependências de artefato: uma para `shared-utils` (repo sem integrações, controle saudável) e outra para o artefato publicado pelo `fulfillment-service` (Gradle), resolvida e instalada manualmente no repositório Maven local para permitir build real cross-ecossistema.

## Achado #1 — Bug real no integrityChecker (encontrado durante a validação do baseline saudável)

**Severidade:** Alta (falso positivo em uma dependência 100% saudável)

Ao rodar o baseline dos 6 repos pela primeira vez, a integração `billing-service → shared-utils`
apareceu como **`broken`**, mesmo sendo o caso de controle deliberadamente saudável (sem nenhuma
alteração feita nela).

**Causa raiz:** `findImportedClasses` (`src/adapters/importScanner.ts`) fazia matching de imports
por prefixo textual simples do `groupId`. Como `shared-utils` tem `groupId = com.repotestes` e
`fulfillment-service` tem `groupId = com.repotestes.fulfillment` (um groupId "irmão" mais
específico, prefixado pelo primeiro), ao checar a integridade da integração
`billing-service → shared-utils` o scanner também capturava o import de
`com.repotestes.fulfillment.OrderFulfillmentHandler` (que pertence à *outra* integração,
`billing-service → fulfillment-service`) e cobrava a existência dessa classe dentro do
código-fonte de `shared-utils` — onde ela obviamente não existe. Resultado: edge saudável
marcado como quebrado, com motivo incorreto.

**Correção aplicada:** `checkPublishedArtifactIntegrity` (`src/graph/integrityChecker.ts`) agora
recebe a lista completa de repos do grupo e exclui, antes de checar a existência das classes, os
imports que pertencem a um `groupId` "irmão" mais específico (mais longo e prefixado pelo groupId
do alvo atual) de outro repo conhecido do grupo. Isso resolve corretamente o caso de groupIds
hierárquicos (`com.repotestes` vs `com.repotestes.fulfillment`), que é um padrão comum em
Maven/Gradle multi-módulo.

**Status após correção:** baseline com os 6 repos ficou 100% saudável — as 5 edges esperadas,
todas `active`:
- `order-service → fulfillment-service`
- `fulfillment-service → analytics-service`
- `analytics-service → reporting-service`
- `billing-service → shared-utils`
- `billing-service → fulfillment-service`

## Cenário 1 — Quebrar no INÍCIO da cadeia (order-service → fulfillment-service)

**Ação:** renomeado o tópico consumido em `fulfillment-service`
(`@SqsListener("orders.created")` → `@SqsListener("orders.created.v2")`), simulando alguém
renomeando o listener sem coordenar com o publisher.

**Resultado observado:**
- `order-service → fulfillment-service`: **`removed`** (corretamente detectado — o par
  publish/consume pelo nome do tópico deixou de casar).
- `fulfillment-service → analytics-service`: **`impacted`** (cascata correta — nó a jusante do
  edge removido).
- `analytics-service → reporting-service`: **`impacted`** (cascata correta — 2 hops a jusante,
  confirma que o BFS de `applyCascadingImpact` não para no primeiro hop).
- Nota do repo `fulfillment-service` recebeu as tags `has-removed-integration`,
  `has-cascading-impact`, `at-risk` (nó vermelho) corretamente.
- Nós `analytics-service` e `reporting-service` corretamente marcados como `impacted-node`
  (amarelo), não `at-risk` (vermelho) — a distinção broken-direto vs impactado-em-cascata se
  mantém correta mesmo 2 hops adiante.

**Veredito:** ✅ Sem gaps. Detecção e cascata funcionam corretamente para quebra no início da
cadeia, inclusive propagando por múltiplos hops.

## Achado #2 — Gap real de cascateamento (surgiu já no Cenário 1, confirma a hipótese que motivou o Cenário 4)

**Severidade:** Alta (nó em risco não é sinalizado numa dependência que aponta diretamente para ele)

Com o Cenário 1 ainda ativo (order→fulfillment quebrado, fulfillment-service com nó `at-risk`),
a integração `billing-service → fulfillment-service` — uma dependência de artefato Maven
completamente diferente, que aponta *diretamente* para o mesmo `fulfillment-service` — permaneceu
**`active`** (verde), e o nó `billing-service` não recebeu nenhuma tag de risco.

**Causa raiz:** `applyCascadingImpact` (`src/graph/cascadeImpact.ts`) faz um BFS que só caminha
**para frente**, a partir do `target` de um edge quebrado/removido, seguindo outras edges onde
esse repo é a **origem** (`source`). Ou seja, ele propaga impacto de "quem depende de mim
(fulfillment) vai ser afetado pelo que eu publico", mas nunca verifica "alguém que depende
*de mim* (fulfillment) via uma dependência de artefato direta também deveria saber que estou
com problema". Como a edge `billing-service → fulfillment-service` tem `fulfillment-service`
como **alvo** (não como origem), o BFS forward-only nunca a alcança, mesmo com
`fulfillment-service` já marcado como nó `at-risk`.

Em outras palavras: o cascateamento hoje modela corretamente "propagação de efeito colateral rio
abaixo de uma integração de mensageria" (A quebra → quem consome de A é afetado), mas **não**
modela "quem depende de um artefato/serviço que está com problema deveria ser avisado", que é
justamente o caso de uma dependência de build/artefato apontando para um serviço instável.

**Impacto prático:** qualquer repo que tenha uma `published_artifact_dependency` (ou
`outbound_http`, `contract_reference`) apontando para um repo que está `at-risk` por causa de uma
integração *diferente* (ex: uma fila quebrada) não recebe nenhum sinal visual — o grafo mostra
uma dependência "saudável" para um alvo que na verdade está quebrado.

**Status:** gap real, ainda não corrigido — registrado aqui para decisão de produto (ver seção de
recomendações no final).

## Cenário 2 — Quebrar no MEIO da cadeia (fulfillment-service → analytics-service)

**Ação:** renomeado o tópico consumido em `analytics-service`
(`kafkaConsumer.subscribe("fulfillment.completed", ...)` → `"fulfillment.completed.v2"`).

**Resultado observado:**
- `fulfillment-service → analytics-service`: **`removed`** (corretamente detectado).
- `analytics-service → reporting-service`: **`impacted`** (cascata correta 1 hop a jusante).
- `order-service → fulfillment-service`: **`active`**, sem nenhuma alteração — confirma que o
  cascateamento **não vaza para trás** (upstream) a partir de um edge quebrado no meio da cadeia,
  que é o comportamento correto.
- Nota do repo `fulfillment-service` recebeu `has-removed-integration` + `at-risk` (agora como
  **origem** do edge removido, diferente do Cenário 1 onde era o alvo — confirma que a severidade
  do nó é calculada corretamente nos dois papéis).
- **Reincidência do Achado #2:** `billing-service → fulfillment-service` permaneceu `active`
  (verde) mesmo com `fulfillment-service` marcado `at-risk`. Mesmo gap, agora confirmado também
  quando o repo-alvo está quebrado como *origem* de uma integração diferente (não só como
  *alvo*, como no Cenário 1) — reforça que a causa é estrutural no BFS forward-only do
  `applyCascadingImpact`, independente de qual lado da edge quebrada o nó ocupava.

**Veredito:** ✅ Sem gaps na detecção/cascata do meio da cadeia em si. ⚠️ Gap do Achado #2
reconfirmado.

## Cenário 3 — Quebrar no FIM da cadeia (analytics-service → reporting-service)

**Ação:** alterado o `@KafkaListener` de `reporting-service` para um tópico diferente do que
`analytics-service` publica, quebrando a última aresta da cadeia (nenhum nó a jusante dela).

**Resultado observado:**
- `analytics-service → reporting-service`: **`removed`** (corretamente detectado).
- Nenhuma outra edge afetada — esperado, já que `reporting-service` é folha (não publica nada
  que outro repo do grupo consuma), então o BFS de cascata não tem para onde propagar.
- Nota de `reporting-service` recebeu `has-removed-integration` + `at-risk`.
- `billing-service → fulfillment-service` e `billing-service → shared-utils` seguiram `active`,
  como esperado (nenhuma relação com o `reporting-service`).

**Veredito:** ✅ Sem gaps. Quebra na ponta final da cadeia é detectada corretamente e,
corretamente, não gera cascata (não há para onde propagar).

## Cenário 4 — Dependência apontando para nó quebrado em outra relação (teste dedicado do gap, via pipeline real de `analyze_impact`/`generate_impact_report`)

Diferente dos cenários anteriores (que olharam só o grafo/HTML), este cenário testou o pipeline
completo de análise de impacto: `diffGraphs` (comparação contra snapshot anterior salvo em
`.traceability/state/`) → `writeImpactReport` → nota `Reports/impact-report__fulfillment-service.md`.

**Ação:** com o baseline saudável salvo como snapshot anterior, quebrado novamente
`fulfillment-service → analytics-service` (mesma alteração do Cenário 2) e rodado
`analyze_impact(repoId="fulfillment-service")`.

**Resultado observado no relatório gerado (`impact-report__fulfillment-service.md`):**
```
## Removidas
- fulfillment-service__publishes-to__analytics-service

## Repos potencialmente impactados (blast radius)
- billing-service
- order-service
- shared-utils
```

**Veredito:** ❌ Gap confirmado e mais grave do que o Achado #2 — este é um problema no
**relatório**, não só na cor do grafo.

## Achado #3 — `blastRadius` do `analyze_impact`/`generate_impact_report` é ao mesmo tempo incompleto e impreciso

**Severidade:** Alta (relatório ativamente enganoso: omite os repos realmente afetados e lista
repos que não estão em risco real)

**O que deveria aparecer:** `analytics-service` e `reporting-service` — ambos comprovadamente
impactados em cascata pelo mesmo cenário no Cenário 2 (via grafo/HTML, `status: "impacted"`).

**O que apareceu:** nenhum dos dois. Em vez disso, o relatório listou `order-service` (que está
rio **acima** do ponto quebrado e não sofre nenhum efeito real — ele continua publicando
normalmente) e `shared-utils` (que não tem relação nenhuma com `fulfillment-service`, exceto
compartilhar o `billing-service` como dependente comum).

**Causa raiz:** `computeBlastRadius` (`src/impact/diffEngine.ts`) é um mecanismo **totalmente
separado** de `applyCascadingImpact` (usado no grafo/HTML). Ele faz um BFS **não-direcionado**
sobre `current.edges` — ou seja, (a) ignora a direção da integração (rio acima e rio abaixo viram
a mesma coisa), e (b) usa apenas as edges que **ainda existem** no snapshot atual. Como a edge
`fulfillment-service → analytics-service` foi removida do grafo atual (ela simplesmente não é
mais gerada, já que o publish/consume não casa mais), o subgrafo `analytics-service ↔
reporting-service` fica **desconectado** de `fulfillment-service` no momento exato em que o BFS
roda — então nunca é alcançado, mesmo sendo o impacto mais óbvio e direto da mudança.

Em resumo, hoje existem **dois algoritmos de impacto divergentes e com premissas opostas** no
mesmo agente:
| | `applyCascadingImpact` (grafo/HTML) | `computeBlastRadius` (relatório de impacto) |
|---|---|---|
| Direção | Direcionado (segue `source → target`) | Não-direcionado (ambos os sentidos) |
| Fonte de edges | Edges atuais **+ edges removidas** reconstruídas do vault | Só `current.edges` (pós-quebra) |
| Resultado no Cenário 4 | Marca `analytics-service`/`reporting-service` como `impacted` corretamente | Não os lista; lista `order-service`/`shared-utils` em vez disso |

**Status:** gap real — **corrigido nesta sessão** (ver seção seguinte).

---

## Correções aplicadas (sessão de continuação, 2026-08-31, depois da refatoração de ServiceNode)

Entre o registro dos Achados #2/#3 e esta seção, outra sessão (`repo-testes-ce`) refatorou
`graphBuilder.ts` para introduzir **nós de serviço** (`ServiceNode`, ex: `svc:topic:orders.created`)
mediando integrações de fila/tópico, em vez de aresta repo-a-repo direta. Antes de corrigir os
Achados #2/#3, foi necessário revalidar a topologia contra essa mudança — o que revelou um
**quarto achado**, uma regressão introduzida pela própria refatoração:

### Achado #4 — Nó de serviço duplicado por tecnologia quebra o matching cross-tecnologia (regressão)

**Severidade:** Crítica (quebra silenciosamente uma integração saudável já validada em sessão anterior)

`getOrCreateServiceNode` identificava o nó pelo id `svc:${serviceType}:${nome}`. Como os adapters
atribuem `serviceType` pela **anotação que casou** (ex: `@KafkaListener` → `"kafka"`,
`@SqsListener` → `"aws-sqs"`), o mesmo tópico lógico `orders.created` — publicado via
`KafkaTemplate.send` em `order-service` (serviceType `"kafka"`) e consumido via `@SqsListener` em
`fulfillment-service` (serviceType `"aws-sqs"`) — gerava **dois nós de serviço diferentes**
(`svc:kafka:orders.created` e `svc:aws-sqs:orders.created`), nunca ligados entre si. Resultado:
`order-service` e `fulfillment-service` ficavam **completamente desconectados** no grafo, mesmo no
cenário saudável — quebrando silenciosamente o matching cross-tecnologia que já tinha sido
validado antes da refatoração.

**Correção:** `svc:topic:${nome}` para nós originados de sinais `topic_name` (fila/tópico) — o id
agora ignora `serviceType` (mantido só como metadado de exibição/ícone, valor do primeiro sinal que
criou o nó). Nós originados de `service_resource` (recursos declarados via IaC) continuam com id
`svc:${serviceType}:${nome}`, já que ali o tipo do recurso é parte real da identidade (um recurso
Lambda e uma fila SQS com nomes coincidentes são coisas diferentes). Revalidado: `order-service` e
`fulfillment-service` voltaram a ficar conectados via `svc:topic:orders.created` com evidências dos
dois lados (Kafka + SQS) no mesmo nó.

### Achado #2 — corrigido

`applyCascadingImpact` (`src/graph/cascadeImpact.ts`) agora distingue dois sentidos de propagação
por tipo de edge:
- **Fluxo de dados/posse** (`queue_publish`, `queue_consume`, `service_declaration`): propaga na
  direção da seta (`source → target`), como antes — quem está a jusante de uma quebra é impactado.
- **Dependência** (`published_artifact_dependency`, `outbound_http`, `contract_reference`,
  `config_endpoint`): propaga na direção **contrária** à seta (`target → source`) — se o alvo de
  quem depende dele está quebrado/impactado, a dependência em si fica `impacted`, e o efeito
  continua se espalhando para quem depende de quem depende, etc.

**Revalidado:** quebrando o início da cadeia (`fulfillment-service` para de consumir
`orders.created`), `billing-service__depends-on__fulfillment-service` — antes intocado — agora
aparece corretamente como `impacted`, junto com a cascata correta a jusante
(`fulfillment-service→...→reporting-service`). `billing-service__depends-on__shared-utils`
permanece `active`, confirmando que a propagação não vaza para dependências realmente saudáveis.

### Achado #3 — corrigido

`computeBlastRadius` (`src/impact/diffEngine.ts`) foi reescrito para reutilizar
`applyCascadingImpact` em vez de um BFS não-direcionado independente: reconstrói edges sintéticas
`removed` a partir do próprio diff (`reconstructRemovedEdges`), roda a mesma cascata direcionada
sobre `current.edges` + essas edges removidas, e o blast radius passa a ser todo repo que sobra em
alguma edge `broken`/`removed`/`impacted` depois da cascata.

**Revalidado:** rodando `analyze_impact(fulfillment-service)` no mesmo cenário (início da cadeia
quebrado), o relatório gerado (`impact-report__fulfillment-service.md`) agora lista blast radius
= `billing-service`, `analytics-service`, `reporting-service` (+ os nós de serviço intermediários)
— exatamente os repos realmente afetados — e **não lista mais** `order-service`/`shared-utils`,
que não têm relação real com a quebra.

### Geração de imagens/diagramas — verificado, funcionando

A pedido explícito de revalidação: `generate_html_report` produz um SVG bem formado (6 `<circle>`
para os 6 repos, 3 `<rect>` rotacionados 45° para os 3 nós de serviço, todas as classes CSS
`.node-broken`/`.node-impacted`/`.svc-node` definidas), tanto no estado saudável quanto durante o
cenário quebrado (cores corretas propagadas, incluindo o nó de serviço `svc:topic:orders.created`
em vermelho). `generate_overview_graph` produz um diagrama Mermaid válido (`flowchart LR` com
subgraph por grupo, nós de serviço como losango `{{ }}`, `linkStyle`/`classDef` coerentes com o
status de cada edge/nó). Nenhum placeholder quebrado, SVG vazio ou referência de imagem morta
encontrada em nenhum dos dois.

---

## Resumo consolidado dos achados

| # | Achado | Severidade | Status |
|---|---|---|---|
| 1 | Falso positivo de integridade por colisão de prefixo de `groupId` (`com.repotestes` vs `com.repotestes.fulfillment`) | Alta | ✅ Corrigido (`src/graph/integrityChecker.ts`) |
| 2 | Cascata do grafo/HTML não propagava para edges de dependência que **apontam para** um nó já em risco | Alta | ✅ Corrigido (`src/graph/cascadeImpact.ts`) |
| 3 | `blastRadius` do relatório de impacto usava lógica não-direcionada e só sobre edges atuais | Alta | ✅ Corrigido (`src/impact/diffEngine.ts`) |
| 4 | Refatoração de `ServiceNode` quebrou o matching cross-tecnologia de tópicos (regressão) | Crítica | ✅ Corrigido (`src/graph/graphBuilder.ts`) |
| 5 | Id de nó de serviço com `:` impede abertura de nota pelo Obsidian | Alta | ✅ Corrigido (`src/graph/graphBuilder.ts`) |
| 6 | Cascata promovia o alvo de uma dependência HTTP/artefato quebrada a origem própria, vazando pra suas integrações saudáveis não-relacionadas | Crítica | ✅ Corrigido (`src/graph/cascadeImpact.ts`) |
| 7 | `ServiceNode` que some por completo da varredura (recurso removido do IaC) perde forma/rótulo em todos os diagramas, mesmo com a edge removida ainda o referenciando | Média | ✅ Corrigido (`src/obsidian/removedEdgeDetector.ts` + 3 call sites) |

**Cobertura confirmada sem gaps** (nesta rodada e na revalidação pós-correção): detecção de quebra
e cascata correta (grafo/HTML + relatório de impacto) para quebra no início, meio e fim de uma
cadeia de mensageria multi-tecnologia (Kafka/SQS) de múltiplos hops via nós de serviço, incluindo
propagação correta em ambas as direções (dado a jusante E dependência a montante), distinção
correta entre nó `at-risk` (quebra direta) e `impacted-node` (cascata), e geração de imagens/
diagramas (SVG do relatório HTML e Mermaid do overview) íntegra em ambos os estados.

Todos os repos fixture e o vault foram deixados no estado saudável (8 edges `active`, snapshot de
impacto reseedado limpo) ao final desta rodada de correções.

**Recomendação para uma próxima sessão:** unificar os dois mecanismos — o ideal é que
`computeBlastRadius` reutilize a mesma noção de cascata direcionada de `applyCascadingImpact`
(incluindo edges removidas reconstruídas do vault) em vez de um BFS não-direcionado independente,
e que esse mesmo resultado direcionado também alimente as edges de dependência de artefato que
apontam para um nó em risco (Achado #2), para que "quem depende de um serviço quebrado" apareça
com o mesmo sinal visual/textual de risco, independentemente do tipo de integração.

_Reversão de todas as alterações de teste para o estado saudável: ver seção final deste
documento._

---

## Achado #5 — Id de nó de serviço com `:` quebra a abertura de nota pelo Obsidian (encontrado pelo usuário)

**Severidade:** Alta (impede o uso normal do Graph View nativo do Obsidian)

Reportado pelo usuário: ao clicar em um nó de fila/tópico no Graph View nativo do Obsidian
(ex: `svc:topic:fulfillment.completed`), o Obsidian mostra o erro `File name cannot contain any of
the following characters: \ / :` e não abre/cria a nota.

**Causa raiz:** o id do `ServiceNode` (`svc:topic:<nome>`, definido em `graphBuilder.ts`) tem `:`
— usado tanto no nome do arquivo da nota de integração (`Integrations/<edgeId>.md`, onde `edgeId`
embute o id do nó de serviço) quanto como alvo de wikilink (`[[svc:topic:...]]`) dentro das notas.
O filesystem do macOS aceita `:` em nome de arquivo (é só o Finder que historicamente o exibe como
`/`), mas o **Obsidian valida isso na própria aplicação**, independente do SO, pra manter o vault
portável entre plataformas (no Windows `:` é proibido de verdade no filesystem) — e rejeita abrir
ou criar uma nota cujo nome/link contenha `:`.

**Correção:** nova função `sanitizeNoteId` em `graphBuilder.ts`, aplicada na construção do id de
todo `ServiceNode` (substitui `\`, `/`, `:` por `_`). `svc:topic:orders.created` virou
`svc_topic_orders.created`. Como nenhum código no projeto faz parsing do id por split de string
(confirmado por busca), a mudança de formato não quebra nada — filenames, wikilinks e ids do
Mermaid (que já sanitizavam separadamente via `sanitizeId` em `mermaidRenderer.ts`) ficam
consistentes.

**Revalidado:** grafo, notas de repo/integração/grupo, overview e relatório HTML regenerados do
zero — nenhum wikilink ou nome de arquivo com `:` restante em nenhum arquivo atual do vault
(varredura completa confirmou). Os relatórios HTML/impacto **arquivados** (histórico com
timestamp, gerados antes desta correção) mantêm os ids antigos com `:` de propósito — são
snapshots históricos e não foram reescritos, então algum link dentro de um relatório arquivado
antigo ainda pode dar esse erro se clicado; os relatórios **atuais** (sem timestamp no nome) estão
limpos.

**Status:** ✅ Corrigido (`src/graph/graphBuilder.ts`).

---

## Cenário 4 (rodada de validação pós-refatoração de Services, 2026-09-02) — Dependência HTTP quebrada

**Topologia usada:** os 3 repositórios adicionados nesta rodada (`notification-service`
Lambda, `payment-processor` ECS, `customer-portal`) — especificamente
`customer-portal --(outbound_http)--> order-service`.

**Ação:** alterada a URL chamada em `customer-portal/src/orderClient.ts` de
`http://localhost:8081/orders` para `http://localhost:9081/orders`, simulando o cenário mais
comum de dependência HTTP quebrada: o serviço-alvo mudou de porta/endpoint e o chamador ficou
com uma URL desatualizada (o `endpoints` de `order-service` em `.traceability/config.json`
continuou apontando para `8081`).

**Resultado observado (antes da correção):** como não existe checagem de integridade para
`outbound_http` (a integração só pode desaparecer, nunca ser marcada `broken` diretamente — ver
`src/graph/graphBuilder.ts:133-138`), a integração ficou `removed`, corretamente. Mas
`applyCascadingImpact` promoveu `order-service` (o alvo da dependência quebrada) a uma ORIGEM
adicional da cascata só por ele ser um repositório — e, a partir dele, a cascata seguiu pela
publicação Kafka saudável do `order-service` (`orders.created`) e contaminou toda a cadeia a
jusante (`fulfillment-service`, `analytics-service`, `reporting-service`, `notification-service`)
mais os dependentes de artefato (`billing-service`, `payment-processor`) — 8 dos 9 repositórios do
grupo (todos exceto `shared-utils`) ficaram amarelos por causa de **um único cliente HTTP com URL
desatualizada**.

## Achado #6 — `applyCascadingImpact` promovia incorretamente o ALVO de uma dependência quebrada a origem de cascata própria

**Severidade:** Crítica (falso positivo em massa: uma única integração de saída quebrada em um
cliente contamina todo o restante do grafo são)

**Causa raiz:** a regra "o outro extremo de uma edge quebrada/removida também vira origem quando é
um repositório" (introduzida para corrigir o Achado #2 original — repo que **para de publicar**
deve propagar para quem **depende do seu artefato**) era aplicada de forma simétrica demais: para
uma edge de DEPENDÊNCIA (`outbound_http`, `published_artifact_dependency`, `contract_reference`,
`config_endpoint`), o "outro extremo" é o ALVO de quem depende dele — e nada indica que esse alvo
esteja, ele mesmo, com problema, só porque **um** cliente perdeu a integração com ele (o caso mais
comum é justamente o cliente ter ficado com um endpoint/versão desatualizado, não o alvo ter
parado). Promovê-lo a origem fazia a cascata vazar pelas integrações saudáveis e completamente
não-relacionadas desse alvo.

**Correção aplicada:** em `src/graph/cascadeImpact.ts`, a promoção do "outro extremo" a origem
adicional agora só ocorre quando a edge raiz é do tipo FLUXO (`queue_publish`/`queue_consume`/
`service_declaration`) — o caso original do Achado #2, onde o outro extremo é o próprio repo que
parou de publicar/declarar (evidência real de problema nele). Para edges de DEPENDÊNCIA, só o lado
que efetivamente depende (`source`) continua virando origem — o alvo dependido não é mais promovido
só por ser um repositório.

**Revalidado:**
- Com a correção: apenas `customer-portal` e `order-service` (as duas pontas literais da edge
  quebrada) ficam vermelhos; todo o resto do grupo permanece verde — sem cascata falsa.
- Regressão do Achado #2 original reconfirmada intacta: quebrando novamente
  `fulfillment-service`'s consumo de `orders.created` (edge de FLUXO), `billing-service →
  fulfillment-service` e, mais um hop, `payment-processor → billing-service` continuam corretamente
  marcados `impacted` — a correção não reintroduziu o gap original.

**Status:** ✅ Corrigido (`src/graph/cascadeImpact.ts`). Repositórios fixture e vault revertidos
ao estado saudável (14 edges `active`) ao final da validação.

## Cenário 5 (rodada de validação pós-refatoração de Services, 2026-09-02) — Recurso de infra removido no Terraform

**Ação:** removido por completo o bloco `resource "aws_ecs_service" "payment-processor-svc"` de
`payment-processor/infra/main.tf` (não só comentado — o regex do detector,
`resource\s+"aws_ecs_service"\s+"([\w-]+)"` em `src/adapters/iacDetector.ts`, não é ancorado à
linha, então comentar com `#` sozinho NÃO teria bastado: o texto continuaria casando dentro do
comentário).

**Resultado observado (antes da correção):** a edge `payment-processor__owns__svc_aws-ecs_payment-processor-svc`
foi corretamente marcada `removed`, e só `payment-processor` e o nó de serviço ficaram vermelhos —
sem vazar cascata para a outra integração saudável do mesmo repo (`payment-processor → billing-service`
ficou verde), confirmando que o Achado #6 não regrediu. Mas o PRÓPRIO NÓ do serviço ficou malformado
em todo lugar que ainda o referenciava: no diagrama do Grupo e no ego-graph da nota de
`payment-processor`, ele apareceu como uma caixa retangular comum com o id cru como texto
(`svc_aws-ecs_payment-processor-svc`) em vez do hexágono com rótulo amigável
(`payment-processor-svc (ecs)`) que aparece quando o recurso existe.

## Achado #7 — `ServiceNode` que desaparece por completo da varredura (não só a edge) perde a forma/rótulo em todos os diagramas

**Severidade:** Média (cosmético, mas confunde: some exatamente a identificação visual do nó no
momento em que ele mais precisa ser reconhecível — quando está quebrado)

**Causa raiz:** o mecanismo de "integração removida" (`listRemovedEdges`) já reconstrói a EDGE a
partir da nota antiga em `Integrations/`, mas não existe equivalente para o `ServiceNode` em si.
`GraphRenderContext.serviceNodesById` (`buildRenderContext`, `src/obsidian/mermaidRenderer.ts`) é
montado só a partir de `snapshot.serviceNodes` da varredura ATUAL — se o recurso de infra que
originou o nó desaparece de vez do código/IaC (não só uma integração dele), o `ServiceNode` some
dessa lista, mesmo com uma edge removida ainda apontando para o seu id. `declareNodeLines`
(`mermaidRenderer.ts`) então não encontra o id em `serviceNodesById` e cai no fallback de "trata
como repositório" — produzindo uma caixa comum com o id cru, sem hexágono nem tipo — e no diagrama
do Grupo (`renderMermaidGraph`), que nem chega a declarar o nó nesse caso, o Mermaid cria um nó
implícito ainda mais cru a partir da própria referência na aresta. Afeta os três lugares que citam
nós de serviço: `Groups/*.md`, `Repos/*.md` (ego-graph) e o relatório HTML — todos constroem o
`GraphRenderContext`/`snapshot.serviceNodes` da mesma forma direta.

**Correção aplicada:** nova função `reconstructMissingServiceNodes(vaultPath, groupId, currentServiceIds)`
em `src/obsidian/removedEdgeDetector.ts` — mesmo padrão do `listRemovedEdges`, mas lendo o
frontmatter de `Services/*.md` em vez de `Integrations/*.md` — reconstrói um `ServiceNode` mínimo
(id, serviceType, label) para qualquer nota de serviço que exista no vault mas não apareça na
varredura atual. A evidência não é reconstruída (só existe no corpo da nota, não no frontmatter) —
mesma perda de fidelidade, por design, que já existe no `snippet` de uma edge removida. Os três
pontos que constroem `snapshot.serviceNodes`/`GraphRenderContext` (`obsidianWriter.ts`,
`overviewWriter.ts`, `generateHtmlReport.ts`) agora mesclam esses nós reconstruídos antes de montar
o contexto de renderização e antes de regravar `Services/*.md`.

**Revalidado:** com a correção, o diagrama do Grupo e o ego-graph de `payment-processor` voltaram a
declarar `svc_aws_ecs_payment_processor_svc{{"payment-processor-svc<br/>(ecs)"}}` (hexágono, rótulo
amigável) mesmo com a edge `owns` removida; o relatório HTML idem (confirmado no HTML gerado,
`&lt;br/&gt;` só é o mesmo texto escapado). Recurso do Terraform restaurado, vault e HTML
regenerados de volta ao estado saudável (14 edges `active`).

**Status:** ✅ Corrigido (`src/obsidian/removedEdgeDetector.ts`, `src/obsidian/obsidianWriter.ts`,
`src/obsidian/overviewWriter.ts`, `src/tools/generateHtmlReport.ts`).
