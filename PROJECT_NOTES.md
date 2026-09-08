# traceability-agent — notas de sessão / contexto para continuidade

Este arquivo resume tudo que foi decidido e implementado até agora, para uma sessão futura
(ou uma sessão isolada rodando dentro desta pasta) continuar o trabalho sem precisar redescobrir
o contexto. Leia isto antes de mexer no código.

## Visão original (o que o usuário pediu)

Um agente de rastreabilidade que:
- Roda como **MCP server**, consumível por qualquer IA/LLM (não só Claude) — requisito explícito
  do usuário desde o início, não abrir mão disso.
- É "importável" em qualquer projeto (sem copiar código) para mapear integrações entre múltiplos
  repositórios que compõem uma mesma aplicação.
- Detecta integrações por dependência de artefato publicado, chamadas HTTP, filas de eventos
  (Kafka/SQS/Rabbit) e contratos compartilhados (OpenAPI/proto/avro).
- Materializa o grafo como notas no Obsidian, com cores por tipo de integração e vermelho quando
  corrompida.
- Analisa impacto de mudanças (diff entre snapshots + blast radius).
- Gera testes de regressão automáticos para as integrações afetadas.
- Também existe uma **Skill do Claude Code** por cima do MCP, para guiar o fluxo dentro do Claude
  Code especificamente (mas o motor real é o MCP server, funciona em qualquer IA).

## Estado atual: tudo isso já está implementado e validado com dados reais

Não é um protótipo parcial — as 4 fases do plano original (mapeamento, grafo, impacto, geração de
testes) mais extensões pedidas depois (cores, relatório HTML, visão macro/micro, arquitetura
importável) estão todas implementadas e testadas.

## Arquitetura

```
Claude Code (ou qualquer LLM/cliente MCP)
        │ stdio (protocolo MCP)
        ▼
MCP Server "traceability-agent" (Node/TS) — src/server.ts
  Tools: scan_repository, map_integrations, update_obsidian_graph,
         analyze_impact, generate_impact_report, generate_regression_tests,
         generate_html_report, generate_overview_graph
        │
        ├─ adapters/        → analisa 1 repo por vez (java-maven, kotlin-gradle, node-npm)
        ├─ graph/           → resolve integrações entre repos + checa integridade estática
        ├─ impact/          → diff entre snapshots + blast radius
        ├─ obsidian/        → gera notas .md (repo/integração/grupo/overview) + relatório HTML
        └─ testgen/         → gera smoke-tests JUnit5 (Java/Kotlin) por integração
```

**IMPORTANTE — modelo de config (mudou no meio da sessão):** o agente **não guarda mais config
de projetos dentro de si mesmo**. Cada projeto que quiser ser rastreado cria seu próprio
`.traceability/config.json` na própria raiz:

```json
{
  "groupId": "nome-do-sistema",
  "repos": [
    { "id": "repo-a", "path": "./repo-a", "language": "java", "buildSystem": "maven", "coordinates": ["com.exemplo:repo-a"] },
    { "id": "repo-b", "path": "./repo-b", "language": "node", "buildSystem": "npm", "coordinates": ["repo-b"], "endpoints": ["http://localhost:8081"] }
  ]
}
```

- `path` é relativo à **raiz do projeto** (a pasta que contém `.traceability/`), não à própria
  pasta `.traceability/`. Cuidado: `path.dirname(path.dirname(configPath))` é o cálculo usado em
  `src/config/groupConfig.ts` — já teve um bug aqui (resolvia para dentro de `.traceability/`),
  foi corrigido.
- `endpoints` é opcional, só necessário para resolver integrações `outbound_http`.
- Todas as tools MCP aceitam `configPath` opcional (default: `<cwd>/.traceability/config.json`).
  Ou seja, rode as tools a partir da pasta do projeto sendo rastreado.
- Estado do grafo (snapshots para diff de impacto) fica em `.traceability/state/` **dentro do
  projeto rastreado**, não dentro deste pacote.
- Um índice leve em `~/.traceability-agent/registry.json` (fora deste pacote) guarda quais
  projetos já foram rastreados (atualizado a cada `update_obsidian_graph`) — usado só para montar
  a visão macro consolidada entre múltiplos projetos no `index.md` do vault.

## MCP server: registro

Registrado com **escopo `user`** (disponível em qualquer projeto/sessão do Claude Code):

```bash
claude mcp add --scope user traceability-agent -- node /path/to/traceability-agent/dist/server.js
```

Verificar: `claude mcp list` deve mostrar `traceability-agent ... ✔ Connected`.
Depois de qualquer mudança no código, rodar `npm run build` (compila `src/` -> `dist/`); a próxima
chamada de tool já usa o código novo (não precisa re-registrar).

## Bugs encontrados em teste real e corrigidos (depois da versão "importável")

Um teste real (corromper `fulfillment-service` mudando `@SqsListener("orders.created")` para
`"orders.created.v2")`, sem tocar em `order-service`) rodado numa sessão separada encontrou 3 bugs:

1. **Integração removida não gerava NENHUM alerta visual** — quando uma edge deixa de ser detectada
   (nome de tópico/endpoint/dependência mudou de um lado só), ela simplesmente sumia do grafo e do
   diagrama, e a nota antiga ficava com `status: "active"` desatualizado, sem sinal nenhum de que
   algo mudou. **Corrigido**: `src/obsidian/removedEdgeDetector.ts` (`listRemovedEdges` +
   `markIntegrationNoteRemoved`) compara as notas já existentes no vault (por grupo) contra a
   varredura atual; o que sumiu vira uma "edge fantasma" com `status: "removed"`, entra nos
   diagramas Mermaid como linha cinza tracejada (`REMOVED_HEX_COLOR` em `colorPalette.ts`), ganha
   tag `#removed` (inclusive no `.obsidian/graph.json`, cor cinza no Graph View nativo) e um banner
   `🗑️` na própria nota, sem apagar a evidência antiga. Chamado automaticamente dentro de
   `writeGraphToVault` (logo, roda em todo `update_obsidian_graph`) e refletido também no `index.md`
   macro via `overviewWriter.ts`. **Pegadinha resolvida no processo**: notas de integração escritas
   ANTES dessa correção não tinham o campo `group` no frontmatter — o detector cai para checar a tag
   do grupo (`fields.tags.includes(groupId)`) como fallback, senão não reconhecia notas antigas.
2. **`kotlinGradleAdapter` retornava `coordinates.artifactId` undefined** quando o `build.gradle.kts`
   não tem bloco `publishing`/`artifactId` explícito (caso comum: serviços internos que não publicam
   artefato, como o `fulfillment-service` do fixture). **Corrigido**: fallback lendo
   `rootProject.name` de `settings.gradle.kts` (é assim que o Gradle de fato nomeia o projeto).
3. **`generate_impact_report` não era robusto** se o `diff` chegasse como string JSON (em vez de
   objeto já parseado) — algo que pode acontecer dependendo de como o cliente MCP repassa o retorno
   de `analyze_impact`. **Corrigido**: `coerceDiff()` faz parse se vier string, valida o formato
   mínimo esperado, e cai para recalcular sozinho se não for reconhecível.

## Requisito reforçado depois: o NÓ do repositório também precisa alertar, não só a aresta

O usuário deixou claro que os dois objetivos centrais são (1) mapear todas as integrações
internas/externas e (2) identificar qualquer alteração que impacte esse relacionamento **com o nó
do repositório em vermelho** (não só a linha/aresta), e um resumo colorido com o motivo visível
assim que se abre/clica no nó. Implementado:

- Toda edge `broken` OU `removed` conta como "impacto" para fins de colorir o repositório (unificado
  — antes só `broken` tinha tratamento especial). `src/obsidian/mermaidRenderer.ts`:
  `computeAtRiskIds`/`atRiskStylingLines` aplicam `classDef atRisk fill:vermelho` + `class <ids> atRisk`
  nos 3 diagramas Mermaid (ego-graph do repo, grupo isolado, macro `index.md`).
- `.obsidian/graph.json` ganhou `tag:#at-risk` → vermelho (prioridade alta, antes de `#repo`), e a
  nota do repo ganha essa tag quando tem qualquer edge broken/removed — assim o Graph View NATIVO
  também pinta o nó do repo de vermelho, não só os diagramas Mermaid.
- `src/obsidian/noteTemplates.ts`: `renderRiskSummary()` insere, logo no topo do bloco gerado da
  nota do repo (primeira coisa visível ao abrir), um resumo com `<span style="color:...">` usando a
  cor exata da legenda (vermelho para broken, cinza para removed) + o motivo de cada integração
  impactada — isso é o "resumo ao clicar no nó" que o usuário pediu.
- `src/reports/htmlReport.ts` e `src/tools/generateHtmlReport.ts` tinham o mesmo problema do bug #1
  (só entendiam `status === "broken"`, nunca `"removed"`) — corrigido em todos os pontos (grafo SVG,
  chip de status, linha da tabela, seção de problemas, stat tiles, pill do topo) e
  `generate_html_report` agora também lê `listRemovedEdges` do vault antes de renderizar.

## Depois disso: esquema de cores simplificado (verde/vermelho) + propagação em cascata

O usuário pediu explicitamente: esquecer cor por TIPO de integração na aresta — a linha deve ser
**sempre verde quando saudável**, e **vermelha quando impactada, propagando até onde o impacto
realmente alcança na cadeia** (não só a aresta que quebrou/sumiu). Também pediu que os nós fiquem
"no mesmo nível" (peer, não em camadas hierárquicas); decidiu-se junto com ele que o **relatório
HTML (SVG circular) é a visualização "mesmo nível"**, já que o Mermaid faz layout automático em
camadas por direção de seta (não dá pra forçar mesmo nível nele sem gambiarra) — não mexemos no
Mermaid por causa disso, ficou documentado como limitação aceita.

Implementado:
- `src/graph/colorPalette.ts`: `ACTIVE_HEX_COLOR` (verde) substituiu `TYPE_HEX_COLORS` como cor da
  LINHA da aresta; `edgeColor()` agora só olha `status` (`active` → verde, qualquer outra coisa →
  vermelho). `TYPE_HEX_COLORS` continua existindo só para o chip de "tipo" na tabela do relatório
  HTML (metadado, não mais a cor da linha).
- **Novo status `"impacted"`** em `EdgeStatus` (`active | broken | removed | impacted`).
- `src/graph/cascadeImpact.ts` (`applyCascadingImpact`): a partir de cada edge `broken`/`removed`,
  faz BFS a favor da direção das setas começando no `target` dela — toda edge `active` alcançável
  vira `impacted` (vermelha, motivo "impacto em cascata"). Chamado nos 3 lugares que montam a lista
  final de edges: `obsidianWriter.writeGraphToVault`, `overviewWriter.scanAllGroups`,
  `tools/generateHtmlReport.ts` — sempre DEPOIS de mesclar as removidas (`listRemovedEdges`), já que
  uma removida também é ponto de partida do cascade.
- Testado de ponta a ponta no cenário `order-service → fulfillment-service → analytics-service`: ao
  quebrar a primeira integração (tópico não bate mais), a segunda — que continua estruturalmente
  íntegra — corretamente virou vermelha/`impacted`, e os 3 nós ficaram vermelhos (Mermaid, Graph View
  nativo via tag `#impacted`/`#at-risk`, e relatório HTML).

## Depois disso: nó em 3 cores (verde/vermelho/amarelo), não só 2

O usuário pediu para diferenciar, no NÓ, quem está diretamente quebrado de quem só está atingido em
cascata: **verde = OK, vermelho = quebra direta, amarelo = só impactado em cascata**. Implementado
inicialmente só para o nó (aresta ficou vermelho/verde); **depois o usuário pediu o mesmo tratamento
para a ARESTA** — `edgeColor()` em `colorPalette.ts` também ficou 3 cores: `active` → verde,
`impacted` → amarelo, `broken`/`removed` → vermelho (tracejado quando `removed`). Ajustado junto:
`.obsidian/graph.json` (tag `#impacted`, que é da NOTA DE INTEGRAÇÃO/aresta, mudou de vermelho pra
amarelo — só `#broken`/`#removed`/`#at-risk` continuam vermelhos), chip/linha de tabela/card do
relatório HTML (`chip-warning`, `row-impacted`, `problem-card-impacted`, com tokens `--warning`/
`--warning-soft` já existentes do ajuste de nó). Resumindo o estado final: **tanto nó quanto aresta
seguem a mesma lógica de 3 cores** — verde saudável, amarelo só-atingido-em-cascata, vermelho
quebra-direta.

- `src/graph/nodeSeverity.ts` (`computeNodeSeverities`/`severityOf`): para cada repo, `broken` se ele
  é origem/destino de uma edge `broken`/`removed`; senão `impacted` se é origem/destino de uma edge
  `impacted`; senão `ok`. Prioridade: `broken` > `impacted` > `ok` (se o repo tem as duas, fica vermelho).
- `IMPACTED_HEX_COLOR` (`#f9a825`, âmbar) em `colorPalette.ts`, ao lado de `ACTIVE_HEX_COLOR`/`BROKEN_HEX_COLOR`.
- Aplicado nos 3 diagramas Mermaid (`mermaidRenderer.ts`: `classDef brokenNode` vermelho +
  `classDef impactedNode` amarelo, cada nó recebe só uma classe conforme sua severidade), na nota do
  repo (`noteTemplates.ts`: tag `at-risk` (vermelho, severidade broken) OU `impacted-node` (amarelo,
  severidade impacted) — nunca as duas; resumo de risco colore cada linha pela severidade DAQUELE
  edge específico), no `.obsidian/graph.json` (`graphViewConfig.ts`: colorGroup `#impacted-node`
  amarelo) e no relatório HTML (`htmlReport.ts`: `.node-broken`/`.node-impacted`, tokens de tema
  `--warning`/`--warning-soft` adicionados nos 3 blocos claro/escuro/escuro-explícito).
- **Importante para quem for testar**: só aparece amarelo se a quebra tiver algo A JUSANTE na cadeia
  (ex: quebrar `order-service → fulfillment-service` deixa `analytics-service` amarelo). Quebrar a
  ÚLTIMA aresta da cadeia (a "ponta") nunca produz amarelo — só os dois endpoints diretos ficam
  vermelhos, porque não há nada depois deles para propagar. Testado nos dois cenários.

## Relatórios: modelo "atual" (sem data) + arquivo automático da versão anterior

Passou por duas iterações:
1. Primeiro trocamos de "nome só com DATA" (sobrescrevia dentro do mesmo dia) para "nome com data E
   HORA completas" (`src/utils/timestamp.ts`, `toFilenameTimestamp`) — cada rodada virava um arquivo novo.
2. **Depois o usuário pediu um modelo diferente**: o relatório "atual" deve ter SEMPRE o mesmo nome
   (sem data/hora — `html-report__<groupId>.html` / `impact-report__<repoId>.md`), fácil de abrir/
   linkar sem precisar descobrir qual é o mais recente. Quando uma nova rodada roda, a versão atual
   (se existir) é renomeada para o histórico usando o **timestamp da própria geração dela** (lido de
   dentro do arquivo — não o timestamp de agora), e só então o novo conteúdo é escrito no nome fixo.
   **Implementado em `src/obsidian/versionedReport.ts`** (`writeCurrentAndArchivePrevious` +
   extratores `extractHtmlGeneratedAt`/`extractFrontmatterGeneratedAt`):
   - HTML: o timestamp de geração fica embutido num `<meta name="traceability:generated-at" content="...">`
     no `<head>` (`reports/htmlReport.ts`), lido de volta na hora de arquivar.
   - Markdown (impact report): já tinha `generatedAt` no frontmatter YAML, só precisou de um regex
     pra extrair de volta.
   - Usado em `tools/generateHtmlReport.ts` e `obsidian/obsidianWriter.ts` (`writeImpactReport`).
   - Testado rodando duas vezes seguidas: a 2ª rodada arquivou a 1ª corretamente com o timestamp
     dela, e `html-report__repo-testes.html` ficou sempre com o conteúdo mais novo.

**Nota**: o usuário apagou manualmente a pasta `Reports/` uma vez (tinha lixo de quando o grupo
picaroon ainda era rastreado, antes de sermos excluídos do escopo) — isso é esperado/aceitável, a
pasta é recriada automaticamente (`ensureVaultStructure`) na próxima vez que qualquer tool escrever
no vault. Reports continuam sendo gerados normalmente para consulta — só ficam de fora do Graph View
nativo (`-path:Reports`, ver seção "Vault Obsidian" acima), que era a reclamação original.

## Tools MCP (todas em `src/tools/`)

| Tool | Parâmetros | O que faz |
|---|---|---|
| `scan_repository` | `repoPath`, `repoId?` | Analisa 1 repo isolado, retorna `RepoAnalysisResult` (coordinates + sinais de integração) |
| `map_integrations` | `configPath?` | Escaneia todos os repos do config, resolve integrações, retorna `GraphSnapshot` (sem gravar nada) |
| `update_obsidian_graph` | `configPath?`, `vaultPath?` | Escaneia + grava notas no vault (repo/integração/grupo) + atualiza `index.md` (visão macro) + registra no registry |
| `analyze_impact` | `configPath?`, `repoId` | Reescaneia, compara com snapshot salvo, retorna diff (added/removed/modified) + blast radius, **persiste novo snapshot** |
| `generate_impact_report` | `configPath?`, `repoId`, `diff?`, `vaultPath?` | Grava relatório markdown em `Reports/` + anota notas de integração afetadas (histórico) |
| `generate_regression_tests` | `configPath?`, `repoId?`, `edgeId?` | Gera smoke-tests JUnit5 (Java/Kotlin, detectando linguagem real do código-fonte) e **escreve direto no repo real** |
| `generate_html_report` | `configPath?`, `vaultPath?` | Gera relatório HTML autocontido em `Reports/` (grafo SVG, tabela, problemas) — **não publicar como Artifact por padrão**, usuário pediu para ficar só local |
| `generate_overview_graph` | `vaultPath?` | Regenera só o `index.md` (visão macro) escaneando o registry — normalmente não precisa chamar manualmente, `update_obsidian_graph` já chama |

## Testes unitários reais nos 3 repos fixture (não é feature do traceability-agent, é dos repos de teste)

A pedido do usuário, os 3 repos de `rePo_testes/` ganharam testes unitários de verdade (lógica
própria de cada serviço, não confundir com `generate_regression_tests` do agente). Padrão pedido:
sufixo `Test` na classe/arquivo, dentro de uma pasta `/tests` na RAIZ do projeto (não a convenção
`src/test/java`/`src/test/kotlin` do Maven/Gradle) — precisou configurar cada build tool pra apontar
pra lá:
- **order-service** (Maven): `<testSourceDirectory>tests/java</testSourceDirectory>` no `pom.xml` +
  `maven-surefire-plugin` versão `3.2.5` explícita (o padrão do Maven não roda JUnit5 sem isso) +
  dependência `junit-jupiter` `5.10.2`. Testes em `tests/java/com/repotestes/orders/`.
- **fulfillment-service** (Gradle): `sourceSets { test { kotlin.srcDirs("tests/kotlin") } }` no
  `build.gradle.kts` + `junit-jupiter`/`kotlin("test")`/`junit-platform-launcher` + `useJUnitPlatform()`.
  Teste em `tests/kotlin/com/repotestes/fulfillment/`. **Precisou instalar Gradle via
  `brew install gradle`** (não tinha no ambiente, e não criamos gradle wrapper pro projeto — rodar
  com o `gradle` global mesmo).
- **analytics-service** (Node): teste em `tests/AnalyticsServiceTest.ts`, rodado com
  `node --test tests/*.ts` (script `test` no `package.json`) usando o suporte nativo do Node 24 pra
  rodar `.ts` direto, sem precisar de `ts-node`/build step. **Duas pegadinhas resolvidas**: (1)
  `package.json` precisa de `"type": "module"` (os arquivos usam `import`/`export`); (2) `node --test
  tests/` (só o diretório, sem glob) não funcionou nessa versão do Node — teve que ser
  `node --test tests/*.ts` explícito; (3) imports relativos entre arquivos `.ts` precisam da
  extensão `.ts` explícita (`./kafkaConsumer.ts`, não `./kafkaConsumer`) — o resolver ESM nativo do
  Node não faz resolução implícita de extensão como bundlers/TS costumam fazer.

Pra tornar os 3 serviços testáveis sem framework de mock, refatorei os stubs de
`KafkaTemplate`/`kafkaConsumer` pra **registrar as mensagens/assinaturas feitas** (lista interna
exposta via getter), e troquei instanciação interna fixa (`new KafkaTemplate()` direto no campo) por
**injeção via construtor** com default (`OrderEventsPublisher(kafkaTemplate: KafkaTemplate = ...)`,
mesma ideia em Java/Kotlin) — permite os testes injetarem o stub e verificarem o que foi "enviado"
sem precisar de broker real nem Mockito. Em `analytics-service`, extraí o handler inline de
`index.ts` pra uma função nomeada exportável (`eventHandler.ts`) pelo mesmo motivo (testável em
isolamento).

**Resultado**: `order-service` 2/2 testes, `fulfillment-service` 1/1, `analytics-service` 2/2 — todos
passando, e reconfirmei que o traceability-agent continua detectando as 2 integrações corretamente
depois do refactor (o refactor não muda nome de tópico nem estrutura de import usada pela detecção).

## Estrutura de arquivos

- `src/adapters/types.ts` — contrato `RepoAnalysisResult`/`IntegrationSignal` (base de tudo)
- `src/adapters/scanUtils.ts` — utilitários de scan compartilhados: `walkFiles`, `findFilesByName`, `scanCodePatterns` (grep genérico), `scanTopicPatterns` (grep com captura de nome de tópico), `scanContractFiles`
- `src/adapters/importScanner.ts` — detecta classes do repo-alvo importadas no código do repo de origem (usado por integrityChecker e testgen)
- `src/adapters/languageDetection.ts` — detecta linguagem-fonte REAL por contagem de arquivos (não confiar no build system: já vimos repo Maven com código 100% Kotlin)
- `src/adapters/javaMavenAdapter.ts`, `kotlinGradleAdapter.ts`, `nodeNpmAdapter.ts` — um por ecossistema
- `src/adapters/adapterRegistry.ts` — escolhe o adapter certo por repo
- `src/config/groupConfig.ts` — resolve `.traceability/config.json` (projeto) + registry global (`~/.traceability-agent/registry.json`)
- `src/config/vaultConfig.ts` — `DEFAULT_VAULT_PATH = ~/ObsidianVaults/traceability-vault`
- `src/graph/types.ts` — `GraphEdge` (com `status: active|broken|removed|impacted`, `brokenReason?`), `GraphSnapshot`
- `src/graph/edgeLabels.ts` — slug/label por tipo de integração (usado em ids de edge e nas notas; não define mais cor)
- `src/graph/colorPalette.ts` — esquema simplificado: `ACTIVE_HEX_COLOR` (verde) para `status: "active"`, `BROKEN_HEX_COLOR` (vermelho) para qualquer outro status (`broken`/`removed`/`impacted`). `TYPE_HEX_COLORS` sobrou só como metadado (chip de "tipo" na tabela do relatório HTML), não colore mais a linha da aresta. `.obsidian/graph.json` tem os mesmos valores em decimal, mantidos manualmente em sincronia.
- `src/graph/cascadeImpact.ts` — `applyCascadingImpact`: propaga `status: "impacted"` (vermelho) a jusante de qualquer edge `broken`/`removed`, via BFS na direção das setas — é o que faz o vermelho "alcançar" até onde o impacto realmente chega na cadeia, não só a aresta que quebrou.
- `src/graph/graphBuilder.ts` — o núcleo: resolve 4 tipos de sinal em edges reais:
  - `repo_coordinate` → casa com `coordinates` de outro repo (dependência de artefato)
  - `url` → casa com `endpoints` configurados de outro repo (HTTP)
  - `topic_name` → casa `queue_publish` de um repo com `queue_consume` de outro pelo MESMO NOME (funciona cross-tecnologia: Kafka publish casa com SQS consume se o nome bater — validado no cenário `rePo_testes`)
  - `contract_file` → casa repos que referenciam arquivo de contrato com o MESMO NOME (basename)
- `src/graph/integrityChecker.ts` — para edges `published_artifact_dependency`: verifica estaticamente (sem compilar) se as classes do repo-alvo importadas pelo repo de origem ainda existem no código-fonte atual do alvo. Achou uma quebra REAL no picaroon (antes de ser removido do escopo).
- `src/impact/diffEngine.ts` — `diffGraphs(repoId, previous, current)`: classifica edges em added/removed/modified/unchanged (relevantes ao repoId), calcula blast radius via BFS não-direcionado
- `src/graph/graphSnapshot.ts` — save/load do snapshot em `<projeto>/.traceability/state/`, com histórico em `state/history/`
- `src/obsidian/noteTemplates.ts` — templates de nota (repo/integração/grupo/relatório de impacto), com marcadores `<!-- AUTO-GENERATED:START/END -->` para preservar edições manuais abaixo do END
- `src/obsidian/obsidianWriter.ts` — grava/mescla notas no vault, preservando cauda manual
- `src/obsidian/mermaidRenderer.ts` — 3 diagramas Mermaid: `renderMermaidGraph` (grupo isolado, usado na nota de grupo), `renderEgoGraph` (visão MICRO por repo: vizinhos diretos + até 5 externos tracejados), `renderOverviewGraph` (visão MACRO: subgraphs por grupo/aplicação)
- `src/obsidian/overviewWriter.ts` — regenera `index.md` completo (lista de apps + diagrama macro), lendo do registry
- `src/reports/htmlReport.ts` — relatório HTML autocontido (sem CDN externo, tema claro/escuro, fontes de sistema deliberadamente — é gerado por código, não faz sentido embutir binário de fonte)
- `src/testgen/` — geração de smoke-tests: detecta linguagem real (`languageDetection`), gera JUnit5 com um `@Test` por classe importada do target (via `Class.forName`), fallback `@Disabled` se nenhuma classe encontrada

## Vault Obsidian

`~/ObsidianVaults/traceability-vault/` — criado do zero nesta sessão. Estrutura:
```
index.md              # visão MACRO (todas as apps rastreadas), regenerado por completo sempre
Groups/<groupId>.md    # visão do grupo isolado (mermaid + lista de repos/integrações)
Repos/<repoId>.md      # visão MICRO (ego-graph) + integrações como origem/alvo
Integrations/<edgeId>.md  # 1 nota por aresta, com evidência + histórico de impacto (preservado)
Reports/               # relatórios de impacto (md) e relatórios HTML
```
`.obsidian/graph.json` é gravado/reaplicado programaticamente por `src/obsidian/graphViewConfig.ts`
(`ensureGraphViewConfig`, chamado dentro de `ensureVaultStructure` — logo, em toda tool que escreve
no vault) — não é mais uma edição manual única, porque o próprio Obsidian reescreve esse arquivo
sozinho durante o uso normal (zoom, arrastar, abrir configurações) e já vimos isso apagar as
`colorGroups`. Campos garantidos a cada execução: `colorGroups` (`#broken`/`#impacted`/`#removed`/
`#at-risk` todos vermelho, prioridade máxima, nessa ordem; depois um grupo por tag de tipo de
integração — só afeta a nota de integração como nó, não a linha; `#repo`/`#group` neutros),
`showArrow: true`, e `search: "-path:Reports -path:Groups -path:index.md"` — o mapa deve mostrar só a
topologia real (repositórios + integrações); `Reports/` (relatórios), `Groups/<id>.md` (nó de
agrupamento — não é um repositório de verdade) e `index.md` (índice geral) são metadados/navegação
com wikilinks para repos/integrações, então viravam nó extra no Graph View poluindo o mapa. O
usuário pediu para tirar os relatórios primeiro, depois pediu pra tirar o nó do grupo também — os
dois ficaram fora. O resto do arquivo (scale, posição etc., estado de UI do usuário) é preservado —
só esses 3 campos são sobrescritos a cada chamada.

**Limitação confirmada em teste real (não é bug)**: o Graph View nativo do Obsidian é renderizado em
`<canvas>` e só colore NÓS — nunca as linhas/arestas. As linhas aparecem sempre cinza (cor padrão do
tema) e ficam roxas no hover (destaque de seleção nativo do próprio Obsidian, não vem do nosso
`colorGroups` e não é configurável por nós). O usuário reportou isso como "aresta não mudou de cor" e
confirmamos juntos que ele estava olhando o Graph View nativo — as arestas verde/vermelho de verdade
só existem nos diagramas Mermaid embutidos nas notas (renderizam **só em modo Leitura**, não no modo
Origem/edição) e no relatório HTML (`generate_html_report`). Isso é esperado e não tem solução via
`.obsidian/graph.json` — não tente "consertar" de novo se reaparecer, é a mesma limitação.
`.obsidian/graph.json` também é reescrito pelo próprio Obsidian ao usar a UI de grafo (ex: zoom,
arrastar), então valores como `scale` mudam sozinhos sem ser bug nosso.

## Skill do Claude Code

`~/.claude/skills/traceability/SKILL.md` (escopo usuário, vale em qualquer projeto). Orienta:
checar/criar `.traceability/config.json`, qual tool chamar em cada fluxo comum, avisos (não
inventar coordinates, avisar antes de gerar testes que escrevem no repo real, não publicar HTML
como Artifact por padrão). Só aparece disponível em sessões NOVAS do Claude Code (carregada no
início da sessão) — não estava disponível na sessão em que foi criada.

## Projetos de teste (fixtures)

- **picaroon** — REMOVIDO do escopo (era um grupo real do usuário, usado só para validar as
  primeiras fases; ele pediu para excluir e trabalhar só com `rePo_testes`). Os repositórios reais
  do picaroon em `~/projetos/` não foram apagados, só o rastreamento deles.
  - Efeito colateral bom que ficou: `~/projetos/picaroon-test-example-kotlin/pom.xml` foi
    corrigido de verdade (bug real do `kotlin-maven-plugin` — plugin `all-open` faltando
    `<dependencies>` correta). Essa correção foi mantida (não é sobre rastreabilidade, é fix real).
  - O teste de regressão gerado nesse repo foi removido a pedido do usuário (órfão sem tracking ativo).

- **`~/projetos/rePo_testes/`** — grupo ativo atual, agora com **9 repos fictícios** em 3
  linguagens, cobrindo uma cadeia de mensageria de 4 hops, dois repos ligados só por dependência de
  artefato Maven, e três repos adicionados depois especificamente para testar caminhos de detecção
  que nunca tinham sido exercitados (infra via IaC e chamada HTTP de saída):
  - `order-service` (Java/Maven, publica Kafka `orders.created`)
  - → `fulfillment-service` (Kotlin/Gradle, consome via SQS `orders.created`, simula grava no
    Dynamo + atualiza datamesh, publica Kafka `fulfillment.completed`)
  - → `analytics-service` (Node/TS, consome Kafka `fulfillment.completed`, republica
    `analytics.processed`)
  - → `reporting-service` (Java/Maven, consome Kafka `analytics.processed` — ponta final da cadeia)
  - `shared-utils` (Java/Maven, utilitário puro sem integrações próprias — ponto de controle
    saudável)
  - `billing-service` (Java/Maven, depende via Maven de `shared-utils` **e** do artefato Gradle
    publicado por `fulfillment-service` — dependência cross-ecossistema real; o jar do
    `fulfillment-service` foi instalado manualmente no repositório Maven local via
    `mvn install:install-file` para viabilizar o build real de `billing-service`)
  - `notification-service` (Node/TS, declara uma **AWS Lambda** via `serverless.yml`
    — `functions: notification-handler`, detectado por `scanServerlessFile` em `iacDetector.ts` — e
    também consome `orders.created`, virando o **segundo consumidor** do mesmo tópico já publicado
    por `order-service`, ao lado de `fulfillment-service`; valida fan-out de um nó de serviço para
    múltiplos consumidores)
  - `payment-processor` (Java/Maven, declara um **AWS ECS service** via Terraform
    — `resource "aws_ecs_service" "payment-processor-svc"` em `infra/main.tf` — e chama
    `billing-service` via HTTP, com um stub local `RestTemplate` cujo `getForObject` tem a URL
    literal na mesma linha, pra casar com a heurística de `scanCodePatterns` que só resolve
    `outbound_http` pra edge real quando o marcador do client HTTP e a URL estão na mesma linha)
  - `customer-portal` (Node/TS, chama **dois repos já existentes** via HTTP —
    `order-service` e `reporting-service` — usando um `fetch` local stub por motivo análogo ao
    `RestTemplate` acima; endpoints configurados em `endpoints: [...]` no `config.json` de cada
    repo-alvo)

  Tudo offline (stubs locais imitando as APIs reais do Kafka/SQS/Spring/HTTP, sem broker/infra
  real). Config em `~/projetos/rePo_testes/.traceability/config.json`. **`aws-ecs` não existia como
  `ServiceType`** antes desses testes — foi adicionado do zero (`adapters/types.ts`,
  `graph/serviceTypeMeta.ts`, regras Terraform + CloudFormation em `iacDetector.ts`) porque o
  usuário pediu especificamente um repo ECS. Isso validou, pela primeira vez com dados reais:
  adapter Node, detecção de SQS, correlação cross-tecnologia/cross-linguagem por nome de evento no
  `graphBuilder`, dependência de artefato cross-ecossistema (Java→Kotlin/Gradle) real e compilável,
  **detecção de infraestrutura via IaC** (`service_declaration`/`service_resource`, arestas "owns"
  pra nó de serviço Lambda/ECS), **resolução de `outbound_http` pra edge real** via `endpoints`
  configurados (nunca tinha sido testado — a lógica existia desde o início mas não tinha nenhum
  caso de teste), e **um nó de serviço com múltiplos consumidores** (fan-out).

## Decisões e limitações conhecidas (não são bugs, são escopo)

- Adapters hoje (10): **Java (Maven)**, **Kotlin (Gradle)**, **Node (npm)**, **Python (pip)**,
  **Ruby (Bundler)**, **C++ (CMake)**, **Go (go.mod)**, **C#/.NET (`*.csproj`)**, **PHP
  (Composer)**, **Rust (Cargo)** — os últimos 4 adicionados na Fase 7 do plano de produtização, ver
  `docs/adapter-authoring-guide.md` pro padrão a seguir. Fixture novo pra validar os 4:
  `inventory-service` (Go) → `pricing-api` (C#) → `invoice-service` (PHP) → `ledger-svc` (Rust),
  cadeia HTTP simples, mesmo padrão de stub local com URL inline dos demais fixtures. Achado real
  no processo: o adapter PHP só detecta o estilo Guzzle encadeado numa linha só
  (`(new \GuzzleHttp\Client())->get($url)`), não construtor+chamada em variável separada — decisão
  deliberada (exigir `->get(`/`->post(` sozinho reintroduziria o mesmo risco de colisão com classe
  de domínio que a exigência de FQCN completo foi escolhida pra evitar), documentada no adapter e
  no guia de autoria.
- **4 repos adicionais** pra cobrir "integrando entre si" + "isolado" nas 4 linguagens novas:
  `settlement-service` (Rust, publica Kafka `payments.processed`) ↔ `fraud-detector` (Go, consome
  o mesmo tópico) — par novo, não reaproveita a cadeia HTTP; `webhook-relay` (PHP) e
  `audit-log-service` (C#) — isolados de propósito (repos de controle, zero integração resolvida).
  Total agora: **20 repos, 21 integrações, 6 componentes conectados** detectados automaticamente.
  Achado real no processo: o regex de `queue_consume`/`queue_publish` do Go (`kafka.ReaderConfig{...}`)
  parava cedo demais quando havia uma chave aninhada ANTES de `Topic:` (`Brokers: []string{...}`,
  uso idiomático real da lib) — corrigido pra tolerar um nível de aninhamento
  (`NESTED_BRACE_TOLERANT` em `goModulesAdapter.ts`).
- Checagem de integridade (`integrityChecker`) só existe para `published_artifact_dependency`
  (classe importada existe no source do alvo?). Não existe checagem de "quebra" para HTTP/fila/
  contrato ainda.
- `outbound_http` só resolve para edge real se o repo-alvo declarar `endpoints` no config — não
  tem heurística automática (diferente de dependência/tópico, que resolvem sozinhos).
- Visão micro (ego-graph) limita a 5 nós externos + "+N externos" — decisão deliberada para não
  poluir (ex: `picaroon-core` tinha 17 dependências externas).
- Nada roda automaticamente (sem git hook, sem CI) — tudo é disparo manual via chamada de tool,
  por decisão explícita do usuário (ambiente 100% local por enquanto).
- `generate_regression_tests` escreve direto no repositório real (decisão explícita do usuário).
- Relatórios HTML ficam só locais em `Reports/` — usuário pediu explicitamente para não publicar
  como Artifact por padrão.
- Cor da aresta é só verde (saudável) ou vermelho (qualquer impacto) — decisão explícita do usuário,
  não reintroduzir cor por tipo na linha sem ele pedir de volta.
- Layout "mesmo nível" (todos os repos como peers, arestas partindo daí) foi resolvido adotando o
  relatório HTML (grafo SVG circular) como a visualização de referência para isso — decisão conjunta
  com o usuário, já que o Mermaid layouta em camadas por direção de seta e não dá pra forçar mesmo
  nível nele sem gambiarra. Não foi implementado (nem pedido) forçar isso no Mermaid.
- **Status em 2026-08-31: cascateamento de impacto, cor dos nós e resumo de risco confirmados
  funcionando pelo usuário**, testados no cenário real `order-service → fulfillment-service →
  analytics-service` com a integração `orders.created`/`orders.created.v2` corrompida de propósito.

## Rodada de testes de gap de detecção (2026-08-31) — ver relatório completo em `test-reports/`

Depois da confirmação acima, foi feita uma rodada sistemática para caçar gaps: quebrar a cadeia de
6 repos no início, no meio e no fim, e testar deliberadamente um repo com dependência de artefato
apontando para um alvo que está `at-risk` por causa de uma integração *diferente* (o cenário que
motivou criar `shared-utils`/`billing-service`). Relatório completo, com causa raiz e trechos dos
relatórios gerados, em **`test-reports/2026-08-31__gap-analysis.md`** — leia esse arquivo antes de
mexer em `cascadeImpact.ts`, `diffEngine.ts` ou `integrityChecker.ts`. Resumo:

1. **Corrigido nesta sessão:** `checkPublishedArtifactIntegrity` dava falso positivo quando o
   `groupId` de um repo (ex: `com.repotestes`, do `shared-utils`) é prefixo textual do `groupId`
   de outro repo do mesmo grupo (ex: `com.repotestes.fulfillment`, do `fulfillment-service`) —
   importava uma classe do repo "irmão" errado e cobrava a existência dela no repo errado. Corrigido
   passando a lista completa de repos para excluir imports que pertencem a um groupId irmão mais
   específico.
2. **Gap real, não corrigido:** quebra no início/meio/fim da cadeia é detectada e cascateada
   corretamente no grafo/HTML (`applyCascadingImpact`), mas esse cascateamento **não alcança** uma
   edge de dependência de artefato cujo **alvo** é um repo já `at-risk` por outra integração — o BFS
   só segue `source → target` a partir do repo quebrado, nunca o sentido contrário. Ex:
   `billing-service → fulfillment-service` continua verde mesmo com `fulfillment-service` vermelho.
3. **Gap real, não corrigido, mais grave:** `computeBlastRadius` (usado por `analyze_impact`/
   `generate_impact_report`) é um algoritmo **totalmente separado** do cascateamento do grafo —
   BFS não-direcionado só sobre `current.edges` (edges que sobreviveram à quebra). Isso faz o
   relatório de impacto **omitir** repos realmente afetados a jusante (a edge quebrada nem existe
   mais no snapshot atual, então o subgrafo fica desconectado do ponto de vista do BFS) e **listar**
   repos que não têm relação real com o problema. Recomendação registrada no relatório: unificar os
   dois mecanismos usando a mesma noção de cascata direcionada + edges removidas reconstruídas do
   vault.

**Atualização (mesmo dia, sessão de continuação):** outra sessão (`repo-testes-ce`) refatorou
`graphBuilder.ts` introduzindo `ServiceNode` (nós de fila/tópico mediando integrações, em vez de
aresta repo-a-repo direta — ver `src/graph/types.ts`). Isso revelou uma regressão nova (Achado #4:
nó de serviço duplicado por `serviceType`, quebrando o matching cross-tecnologia Kafka/SQS) e deu
oportunidade de corrigir os Achados #2 e #3 acima. **Os 4 achados estão todos corrigidos agora**:
- `checkPublishedArtifactIntegrity` exclui imports de groupId irmão mais específico (Achado #1).
- `getOrCreateServiceNode` identifica nós de tópico só pelo nome (`svc:topic:<nome>`), não mais por
  `serviceType`, restaurando o matching cross-tecnologia (Achado #4).
- `applyCascadingImpact` agora propaga em dois sentidos conforme o tipo de edge: fluxo de dados
  (fila/posse) segue a seta, dependência (artefato/HTTP/contrato/config) propaga na direção
  contrária — se o alvo de uma dependência está em risco, a dependência e quem depende dela também
  ficam `impacted` (Achado #2).
- `computeBlastRadius` (`src/impact/diffEngine.ts`) foi reescrito para reutilizar
  `applyCascadingImpact` (incluindo edges removidas reconstruídas do próprio diff) em vez de um BFS
  não-direcionado independente — unificando os dois mecanismos de impacto do agente (Achado #3).

Detalhe completo de cada achado, causa raiz e revalidação em
`test-reports/2026-08-31__gap-analysis.md`. Todos os repos fixture e o vault foram deixados no
estado saudável (8 edges `active`, incluindo os 3 nós de serviço) ao final — nenhuma alteração de
teste ficou pendente.

## Comandos úteis para depuração rápida (sem passar pelo protocolo MCP)

```bash
cd ~/projetos/traceability-agent && npm run build

# rodar qualquer lógica direto via dist/, ex (a partir da pasta do projeto rastreado):
cd ~/projetos/rePo_testes && node -e '
import("/path/to/traceability-agent/dist/adapters/adapterRegistry.js").then(async ({ analyzeRepository }) => {
  const { loadGroupConfig } = await import("/path/to/traceability-agent/dist/config/groupConfig.js");
  const config = loadGroupConfig();
  console.log(config.repos.map(r => analyzeRepository(r.path, r.id)));
});
'
```

## Rodada de testes 2026-09 (sessão de continuação): 3 adapters novos, multi-aplicação, mais 2 achados

Depois da rodada de 2026-08-31 (achados #1-#5), uma sessão de continuação sistemática ("suíte de
testes", um cenário de cada vez, sempre revertido ao baseline saudável depois) adicionou e validou:

- **3 adapters novos**: `pythonPipAdapter.ts` (requirements.txt), `rubyBundlerAdapter.ts` (Gemfile),
  `cppCmakeAdapter.ts` (CMakeLists.txt) — mesmo padrão dos existentes. `Language`/`BuildSystem`
  (`adapters/types.ts`) e `LANGUAGE_META` (`graph/languageMeta.ts`) estendidos.
- **`src/graph/connectedComponents.ts`** (`findConnectedComponents`): dois (ou mais) repositórios no
  MESMO grupo/config podem não ter NENHUMA integração entre si (times/aplicações independentes que só
  compartilham a pasta) — antes eram sempre desenhados juntos como se fossem uma coisa só. Agora a
  nota de Grupo, o relatório HTML e o `index.md` (Mapa geral) detectam automaticamente quantos
  componentes conectados existem e desenham cada um separado (`### Aplicação N`), sem precisar de
  config manual por aplicação.
- **Achado #6** — `applyCascadingImpact` promovia o ALVO de uma dependência quebrada (HTTP/artefato)
  a origem própria de cascata só por ser um repositório, vazando pelas integrações saudáveis e
  não-relacionadas desse alvo (ex: cliente HTTP com URL errada pra `order-service` marcava como
  impactado todo o Kafka do `order-service`). **Corrigido**: a promoção do "outro extremo" a origem
  só acontece quando a raiz é uma edge de FLUXO (o caso original do Achado #2); pra dependência, só
  quem efetivamente depende (`source`) vira origem.
- **Achado #7** — quando um recurso de infra some por completo da varredura (não só a edge — ex:
  bloco do Terraform removido), o `ServiceNode` em si desaparecia de `snapshot.serviceNodes`, e os
  diagramas perdiam o hexágono/rótulo amigável desse nó (viravam caixa crua com o id como texto)
  mesmo com uma edge removida ainda o referenciando. **Corrigido**: `reconstructMissingServiceNodes`
  (`obsidian/removedEdgeDetector.ts`) reconstrói o nó a partir da nota antiga em `Services/`, mesmo
  padrão do `listRemovedEdges` pra edges.
- **Feature nova — "avisar sem quebrar"**: uma mudança de versão saudável (sem quebrar nada) não
  aparecia em lugar nenhum antes. `diffEngine.ts` ganhou `versionChangeAwareness`
  (`findVersionChangeDependents`): pra cada dependência modificada que continua `active`, lista quem
  depende (transitivamente) do repo que mudou de versão, pra dar ciência mesmo sem efeito colateral
  detectado. Nova seção no relatório de impacto: "Repositórios a avisar (mudança de versão sem
  quebra detectada)".
- **Filtros de ruído em `scanUtils.ts`**: `isCommentOrImportLine` (ignora `//`/`/*`/`*`/`#`/
  `import`/`require`) e `isDeclarationOfMatchedIdentifier` (ignora a própria declaração de uma
  classe/função com o mesmo nome do client, ex: `class RestTemplate {`) — achado real: um stub local
  reimplementando a assinatura de um client HTTP real batia no mesmo regex usado pra detectar USO
  dele (a declaração da classe, o import, e até um comentário mencionando o nome). Aplicado em
  `scanCodePatterns` e `scanTopicPatterns`, usado por TODOS os adapters.
- **Ego-graph** (`renderEgoGraph`) ganhou visibilidade pra chamada HTTP não resolvida (antes só
  dependência de artefato não resolvida aparecia como nó externo tracejado) — usa `arquivo:linha`
  como rótulo, já que o `target.value` de uma chamada não resolvida é só o texto do regex (não
  identifica a chamada).
- **Bug do usuário**: 3 arquivos vazios (0 bytes) na RAIZ do vault (resquício de quando o Obsidian
  criava um stub automático pra um wikilink ainda não resolvido, antes das notas de `Services/`
  existirem) faziam alguns nós de serviço abrirem em branco — 2 notas com o mesmo nome no vault,
  Obsidian resolvia pra qualquer uma. Removidos manualmente, sem correção de código necessária (não
  eram gerados pelo agente).
- **`.obsidian/graph.json`**: além do já documentado (search filter + colorGroups reaplicados a cada
  `update_obsidian_graph`), ajustado manualmente `centerStrength`/`repelStrength` pra separar melhor
  visualmente aplicações desconectadas no Graph View nativo (não é algo que o agente reaplica
  sozinho — é ajuste de UI do usuário, preservado como o resto do arquivo).
- Pesquisa de mercado feita a pedido do usuário: ferramentas parecidas existem (Backstage, Riftmap,
  Service Graph MCP Server, Augment Code) mas nenhuma faz esta combinação específica (MCP + Obsidian
  + leque de linguagens leve + cascata direcionada por tipo de sinal) — decisão: continuar.

Cobertura de linguagens/casos validados nesta rodada, além do que já estava em
`test-reports/2026-08-31__gap-analysis.md`: fan-out parcial (1 de N consumidores quebra, outros
continuam saudáveis), dependência removida por completo (bloco do manifesto apagado) vs. classe
importada removida (2 caminhos de código diferentes: `removed` vs `broken`), endpoint referenciado
via variável (limitação documentada — regex de 1 linha não segue variável), grupo de controle
negativo (comentário/código morto/arquivo novo isolado não deve acender NADA — confirmado limpo).
Ver `test-reports/2026-09-03__test-plan-matriz-cenarios.md` pra matriz completa (o que já foi
testado vs. gaps reais em aberto, ex: `contract_reference` nunca exercitado, `config_endpoint`
nunca implementado por nenhum adapter, fan-in nunca testado).

## Fase 5+ — produtização (em andamento, ver plano completo)

Depois da rodada acima, o usuário decidiu evoluir o objetivo: de "mapear e analisar sob demanda"
pra "mitigar problemas durante a codificação", mantendo rastreabilidade pra virar teste de
regressão no futuro (MVP2). Plano completo, com fases numeradas e decisões já confirmadas
(descentralizar config via `manifest.json` por repositório, 4 linguagens novas — Go/C#/PHP/Rust —,
desenho de 3 gatilhos dev-time sem implementar ainda), em
`~/.claude/plans/quero-criar-um-agente-noble-puppy.md`. Ordem de execução: Fase 5 (estruturação —
suíte de testes automatizados, extrair `analyzeGroup()`, esta atualização de docs) → Fase 6 (config
descentralizado) → Fase 7 (adapters novos) → Fase 8 (desenho só, sem implementar).

**Fase 5 concluída nesta sessão**: `npm test` (node:test nativo, zero dependência nova) com 20
testes cobrindo os achados #1, #2, #3, #4, #6, #7 e o falso-positivo de regex — todos ancorados na
função exata corrigida, não só nos repos fixture manuais. `src/config/groupAnalysis.ts`
(`analyzeGroup`) extrai o padrão `config → repos → grafo` antes duplicado em 4 tools
(`map_integrations`, `analyze_impact`, `update_obsidian_graph`, `generate_regression_tests`) — é o
ponto de extensão que a Fase 6 (manifesto por repositório) usa, sem precisar duplicar o refactor
depois. `docs/adapter-authoring-guide.md` criado como checklist pras 4 linguagens da Fase 7.

**Fase 6 concluída**: `src/config/manifest.ts` (`writeManifest`/`readManifest`/`discoverManifests`)
— cada repo pode ser escaneado sozinho e publicar um `manifest.json`; `GroupRepoConfig.path` virou
opcional, com `manifestPath`/`GroupConfig.manifestsDir` como alternativa. `analyzeGroup` resolve
cada repo por `path` OU `manifestPath`, misturáveis no mesmo grupo. `src/cli/index.ts` (+ `"bin"`
em `package.json`) roda scan sem cliente MCP: `traceability-agent scan . --repo-id id`. Guard rail
em `integrityChecker.ts`: se `repoPath` não existe localmente (repo resolvido via manifesto gerado
noutra máquina), a checagem de integridade é pulada com aviso em vez de marcar quebrado
(`src/graph/integrityChecker.test.ts`, teste "não marca quebrado quando o repoPath do alvo não
existe localmente").

**Fase 7 concluída**: 4 adapters novos — Go (`goModulesAdapter.ts`, `go.mod`/`kafka-go`), C#/.NET
(`csharpDotnetAdapter.ts`, `*.csproj` via `fast-xml-parser`/`Confluent.Kafka`), PHP
(`phpComposerAdapter.ts`, `composer.json`, exige FQCN completo tipo `\GuzzleHttp\Client` pra evitar
colisão com classe de domínio `Client`), Rust (`rustCargoAdapter.ts`, `Cargo.toml` parseado
linha-a-linha, sem dependência de parser TOML, `reqwest::`/`rdkafka`). Pré-requisito resolvido em
`scanUtils.ts`: `isCommentOrImportLine` reconhece `use`/`using` além de `import`/`require`;
`isDeclarationOfMatchedIdentifier` reconhece a ordem invertida do Go (`type Client struct`).

**Fase 8 concluída (só o núcleo, sem os 3 gatilhos dev-time)**: `src/impact/impactCheck.ts`
(`runImpactCheck({configPath, repoId, persist})`) extrai a lógica de `analyze_impact` pra ser
reaproveitável por qualquer superfície futura (tool MCP síncrona, git hook, gate de CI) —
`analyze_impact` e a checagem read-only de `generate_impact_report` já usam esse núcleo. Os 3
gatilhos em si (tool `check_impact_of_change`, pre-commit hook, gate de CI) continuam só desenhados
no plano, não implementados.

**Fixtures novas em `~/projetos/rePo_testes/`** (agora 20 repos): trio Python/Ruby/C++
(catalog-service/pricing-service/ledger-service); cadeia HTTP Go→C#→PHP→Rust
(inventory-service/pricing-api/invoice-service/ledger-svc); par Kafka Rust/Go isolado do resto
(settlement-service produtor → fraud-detector consumidor); dois repos isolados de controle
(webhook-relay em PHP, audit-log-service em C# — este depois conectado via Kafka consumindo
`orders.created` da Aplicação 1, especificamente pra validar relatório/report com uma integração
cross-linguagem de verdade). Todos os cenários de quebra (edge removida de um lado só, dos dois
lados, quebra no meio de uma cadeia de 4 hops) foram validados manualmente e revertidos de volta ao
baseline saudável (22 edges ativas, 0 problema).

## Esquema de cores: 4 níveis (laranja para cascata, amarelo como aviso de versão)

Pedido do usuário: separar visualmente "quebra por cascata" de "algo mudou mas não quebrou" (o
exemplo dado foi mudança de versão de uma dependência — o repo que depende dela pode continuar
funcionando perfeitamente com a versão antiga, então não é o mesmo tipo de alerta que uma cascata
real). Antes disso o esquema era 3 cores (verde/vermelho/amarelo, amarelo = cascata). Virou 4:
verde (saudável) → **amarelo (NOVO — aviso de versão)** → **laranja (era amarelo — cascata)** →
vermelho (quebra direta). Documentado em detalhe em `docs/visual-design-system.md` (seção 1, agora
com as 4 cores e a explicação de por que `versionWarning` é ortogonal a `EdgeStatus`).

Pontos de implementação, todos tocados:
- `src/graph/types.ts`: `GraphEdge.versionWarning?: boolean` — booleano ortogonal a `status`, nunca
  vira raiz de cascata em `applyCascadingImpact` (que só olha `broken`/`removed`).
- `src/graph/colorPalette.ts`: `IMPACTED_HEX_COLOR` virou laranja (`#ef6c00`); `WARNING_HEX_COLOR`
  novo, reaproveita o hex amarelo antigo (`#f9a825`).
- `src/graph/versionWarnings.ts` (novo): `flagVersionWarnings(edges, previousSnapshot)` — compara
  `edge.version` por id contra uma baseline anterior, só pra edges `active`.
- `src/graph/graphSnapshot.ts`: `loadRenderBaseline`/`saveRenderBaseline` — arquivo **separado**
  (`render-baseline.json`) do snapshot de `analyze_impact` (`graph-snapshot.json`/`history/`), de
  propósito: `update_obsidian_graph`/`generate_html_report` rodam com muita mais frequência, e
  avançar o snapshot de `analyze_impact` a cada regeneração de grafo esconderia mudanças reais de um
  `analyze_impact` posterior. Sem histórico — é só um marcador de "última vez que alguém olhou o
  grafo", sempre sobrescrito; por isso um `versionWarning` é transiente (aparece uma vez, some assim
  que qualquer uma das duas tools reconhece a mudança), diferente de `broken`/`impacted` que
  persistem até a causa real ser corrigida. `src/obsidian/overviewWriter.ts` (Mapa geral) só **lê**
  essa baseline, nunca salva — quem avança é sempre `update_obsidian_graph`/`generate_html_report`.
- `src/graph/nodeSeverity.ts`: `NodeSeverity` ganhou `"warning"`, rank
  `ok(0) < warning(1) < impacted(2) < broken(3)`.
- `src/obsidian/mermaidRenderer.ts`, `noteTemplates.ts`, `graphViewConfig.ts`,
  `src/reports/htmlReport.ts`, `overviewWriter.ts` (legenda do `index.md`): todos os 3 diagramas
  Mermaid, as notas de repo/serviço/integração/grupo, o `colorGroups` do Graph View nativo
  (`tag:#warning` novo, entre `#impacted` e `#ok`) e o relatório HTML atualizados pra 4 cores. No
  relatório HTML, "Avisos de versão" é uma seção **separada** de "Problemas encontrados" (não conta
  pro pill "N problemas" — um aviso não é uma quebra) — CSS tokens `--impacted`/`--warning`
  injetados direto de `colorPalette.ts` pra garantir que a cor bata com o diagrama.
- Testes novos: `src/graph/versionWarnings.test.ts`, `src/graph/nodeSeverity.test.ts` (8 testes) —
  suíte total foi de 47 para 55.
- Validado ponta a ponta contra `rePo_testes`: bump de versão em `billing-service/pom.xml`
  (dependência de `shared-utils`) gerou `versionWarning: true` real, confirmado em amarelo no
  diagrama Mermaid, na nota do repo, no `graph.json` nativo e no relatório HTML — depois revertido
  ao baseline original.

**Decisão de escopo tomada durante a implementação, não pedida:** `TYPE_HEX_COLORS` (cor por tipo
de integração — dependência, HTTP, fila...) foi deliberadamente **não** tocado, mesmo cogitado
brevemente pra evitar "colisão" com o novo laranja. Só as cores de status (`ACTIVE`/`WARNING`/
`IMPACTED`/`BROKEN_HEX_COLOR`) mudam — o legado de cor-por-tipo continua intacto.

## Checagem de integridade de contrato (`contract_reference`) — detecção de quebra de API

Antes disso, `contract_reference` (arquivos `.proto`/`openapi.yaml`/`swagger.json`/`.avsc`) nunca
era marcada `broken` — o `graphBuilder` só casava dois repos que referenciam um arquivo de contrato
**com o mesmo nome** e resolvia a edge sempre `{ broken: false }`; a única forma de sinal era o
mecanismo genérico de `removed` (o arquivo sumir/ser renomeado de um lado). Uma quebra real de
schema (campo obrigatório removido, endpoint removido) enquanto o arquivo continua existindo com o
mesmo nome passava batido, sempre verde.

Implementado `src/graph/contractIntegrity.ts` (`checkContractIntegrity`) + `src/graph/
contractSignature.ts` (`extractOpenApiOperations`/`extractSwaggerJsonOperations`/
`extractContractOperations`), ligado em `graphBuilder.ts` no lugar do `{ broken: false }` fixo:

- **Só openapi.yaml/yml e swagger.json** têm diff estrutural — extrai o conjunto de operações
  (`"MÉTODO /caminho"`) do bloco `paths:` via parser leve por indentação (YAML) ou `JSON.parse`
  direto (Swagger), sem dependência de parser YAML completo (mesmo espírito do parser
  linha-a-linha do `Cargo.toml` da Fase 7). **`.proto`/`.avsc` continuam fora de escopo** de
  propósito — extrair campo/número de campo de Protobuf ou schema Avro sem uma dependência de
  parser dedicada tem risco real de falso-positivo (comentário/`oneof`/`reserved` mal
  interpretados como campo removido), e o agente historicamente evita isso (mesma lógica do FQCN
  completo exigido no PHP, do Go `type X struct` excluído do HTTP scan, etc.).
- **É uma checagem ESTRUTURAL entre as duas cópias ATUAIS** (não contra um snapshot anterior, ao
  contrário de `checkPublishedArtifactIntegrity`/`versionWarning`) — não precisa de histórico: se
  as duas cópias do mesmo `openapi.yaml` têm conjuntos de operações diferentes, isso já é
  evidência direta de contrato divergente entre as duas partes.
- **Limitação de design conhecida e documentada, não um bug**: sem um papel explícito de
  provider/consumer por repo (que não existe no modelo de config hoje), a comparação é simétrica —
  não distingue "uma operação nova foi adicionada de um lado" (seguro) de "uma operação sumiu que
  o outro lado ainda espera" (quebra real). Qualquer divergência no conjunto de operações é
  reportada como `broken`, com o motivo listando de qual lado cada operação está ausente, pra quem
  lê decidir. Ver teste "operação só ADICIONADA de um lado também é reportada como divergência" em
  `src/graph/contractIntegrity.test.ts`.
- Testes novos: `src/graph/contractSignature.test.ts`, `src/graph/contractIntegrity.test.ts` — 11
  testes, suíte total foi de 55 para 66.

**Validado ponta a ponta** com um par isolado novo em `rePo_testes`: `orders-api-provider` (Node) +
`orders-api-consumer` (Python), cada um com sua própria cópia de `openapi.yaml` (2 operações: `GET
/orders/{id}`, `POST /orders`). Dois cenários confirmados e revertidos:
1. Removendo `POST /orders` só do lado do provider (arquivo continua existindo) → edge vira
   `broken` de verdade, com o motivo citando a operação exata ("ausente em openapi.yaml: POST
   /orders") — o gap que motivou a feature.
2. Renomeando/removendo o `openapi.yaml` do consumer por completo → mecanismo pré-existente de
   `removed` continua funcionando normalmente (não foi afetado pela mudança).

### Detalhe estruturado do diff nos relatórios (pedido logo depois, mesma sessão)

Pedido do usuário: "é possível pra que ele adicione nos reports o que foi quebrado dentro do
contrato?" — o `brokenReason` original já citava a operação, mas embutido numa frase única
("Contrato divergente entre as duas cópias — ausente em openapi.yaml: POST /orders"), ambíguo
sobre QUAL repo tinha a operação ausente (os dois arquivos se chamam igual) e ilegível quando há
mais de 1 operação divergente.

Solução: `ContractIntegrityResult` (`contractIntegrity.ts`) agora retorna dois campos separados —
`reason` (frase curta, com os **ids dos repos**, não mais o nome do arquivo, pra desambiguar: "
Contrato de openapi.yaml divergente entre orders-api-consumer e orders-api-provider (1 operação
fora de sincronia).") e `diffDetails` (array, uma linha por operação: "ausente em
orders-api-provider: POST /orders"). `GraphEdge` ganhou `contractDiffDetails?: string[]` pra
carregar isso até os renderizadores. `checkContractIntegrity` agora recebe também os `repoId` dos
dois lados (antes só recebia `repoPath`/`relativeFile`), passados por `graphBuilder.ts`.

Renderização: `reason` continua sendo o que aparece nos lugares de resumo compacto (resumo de
risco da nota de repo/serviço, tabela do relatório HTML) — **não mudou** de propósito, pra não
poluir esses espaços apertados. `diffDetails`, quando presente, vira uma lista (`- item` em
markdown na nota de integração; `<ul class="problem-diff-list">` no card de "Problemas
encontrados" do relatório HTML) exibida ADICIONALMENTE ao `reason`, só nos dois lugares com espaço
de sobra pra detalhar. Generaliza bem pra N operações divergentes nos dois sentidos (testado em
`contractIntegrity.test.ts`).

Descoberta lateral durante o teste desse cenário: o parser de `extractOpenApiOperations`
(`contractSignature.ts`) só reconhece o método HTTP em estilo bloco (`get:` sozinho na linha,
valor no bloco indentado abaixo) — YAML flow-style na mesma linha (`get: {summary: x}`) não bate
no regex e a operação simplesmente não é contada. Documentado como limitação conhecida (não é
problema prático, nenhum gerador OpenAPI real emite flow-style pra operações).

## Diff de CAMPOS do contrato (tipo/tamanho/restrição), não só de operações — com/sem consumidor mapeado

Pedido do usuário, depois de enriquecer o contrato de `orders-api-provider`/`orders-api-consumer`
com `components.schemas` (tipos, `minLength`/`maxLength`, `pattern`, `minimum`/`maximum`, `enum`,
`required`): a regra completa que ele descreveu foi **(1)** se um `path` some, alerta como já fazia
(inalterado); **(2)** se um CAMPO do schema muda, olhar se existe algum repo consumindo aquele
contrato — se sim, é quebra real (`broken`); se não há nenhum consumidor mapeado no momento, é só
um `warning` (pode ter impacto, mas não dá pra confirmar sem saber quem usa).

**Novo módulo `src/graph/miniYaml.ts`** — parser genérico de um SUBCONJUNTO de YAML (mapeamentos e
sequências em bloco, escalares tipados, array inline `[a,b,c]`, aspas simples/duplas; sem
âncoras/aliases/flow-mapping/multiline). Criado porque navegar `components.schemas.<Nome>.
properties.<campo>.<atributo>` com regex por indentação fixa (como `extractOpenApiOperations` já
fazia pra `paths`) ficaria frágil demais com um nível extra de aninhamento — um parser de árvore
genérico é mais robusto e testável (9 testes próprios em `miniYaml.test.ts`).

**`src/graph/contractSignature.ts`** ganhou `extractContractSchemas(fileName, content)` — navega a
árvore do mini-YAML (ou `JSON.parse` direto pra `swagger.json`) e monta uma
`Map<"Schema.campo", ContractFieldSignature>` com tipo (`type`, incluindo `$ref` resolvido pra
"ref:NomeDoSchema" sem seguir a referência recursivamente), `required`, `format`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `enum` (ordenado) e `itemsType` (pra array). Mesma
decisão de escopo de `extractContractOperations`: só openapi.yaml/yml e swagger.json,
`.proto`/`.avsc` retornam `undefined`. `serializeFieldSignature` vira uma string curta e
determinística por campo — usada tanto pra exibir "o que o campo diz hoje" quanto como valor de
comparação.

**`src/graph/contractIntegrity.ts`**: `checkContractIntegrity` (usada quando HÁ sibling/consumidor
mapeado) agora soma dois diffs — o de operações (já existia) e um novo diff campo-a-campo entre as
duas cópias ATUAIS (`diffSchemasBetweenRepos`) — qualquer divergência em qualquer um dos dois vira
`broken`, com `diffDetails` citando "Schema.campo: repoA declara \"...\", repoB declara \"...\"".
Duas funções novas pro caminho SEM sibling: `buildContractSchemaFingerprint(repoPath, file)` (lê o
arquivo, monta o fingerprint) e `diffContractFingerprints(previous, current)` (diff TEMPORAL entre
duas execuções do MESMO arquivo, usado só quando não há ninguém pra comparar estruturalmente).

**`src/graph/graphBuilder.ts`**: o loop de `contract_reference` que antes só criava edge quando
`relatedRefs.length > 0` (sibling existe) ganhou um branch pro caso `relatedRefs.length === 0`
(contrato ISOLADO) — em vez de descartar o sinal (como acontecia antes, silenciosamente, pra
QUALQUER contrato sem sibling), materializa uma edge `repo -> ServiceNode` própria (`svc:contract:
<repoId>/<arquivo>`, novo `ServiceType: "contract"` em `adapters/types.ts`/`serviceTypeMeta.ts`),
carregando o fingerprint de schema. Isso por si só já é uma mudança de comportamento (contratos sem
consumidor agora aparecem no grafo, antes eram invisíveis) — intencional, é o que viabiliza o aviso.

**`src/graph/contractSchemaWarnings.ts`** (novo, mesmo padrão de `versionWarnings.ts`):
`flagContractSchemaWarnings(edges, previousBaseline)` — marca `versionWarning: true` +
`contractDiffDetails` em toda edge de contrato isolado cujo fingerprint mudou desde a
render-baseline anterior (reaproveita a MESMA baseline de `flagVersionWarnings`, chamada em
sequência nos mesmos 3 lugares: `updateObsidianGraph.ts`, `generateHtmlReport.ts`,
`overviewWriter.ts`). Sempre `warning`, nunca `broken` — sem sibling mapeado não dá pra confirmar
que alguém depende do campo que mudou.

**Correção de texto feita durante a validação**: o texto de `versionWarning` (heading, motivo,
label do Mermaid, item da lista do Grupo) foi escrito originalmente só pensando em versão de
dependência (`"Versão referenciada mudou para X..."`) — pra uma edge de contrato isolado
(`edge.version === undefined`), isso mostrava um `?` sem sentido. Todos os 4 lugares
(`noteTemplates.ts`'s `impactReason`/`impactHeading`/`renderEdgeListItem`, `mermaidRenderer.ts`'s
`edgeLabel`, `htmlReport.ts`'s `renderVersionWarnings`) agora checam `edge.version === undefined`
pra escolher entre a frase de versão e uma frase de "o schema deste contrato mudou". `htmlReport.ts`
também ganhou a lista `<ul class="problem-diff-list">` na seção "Avisos de versão" (já existia só
em "Problemas encontrados").

**Bug real encontrado e corrigido durante a validação, mas no HARNESS de teste, não no produto**:
os scripts de regeneração manual (`regen.mjs`/`regen-html-only.mjs`, fora do repo do agente, usados
só nesta sessão pra simular as tools sem passar pelo protocolo MCP) foram escritos ANTES de
`flagContractSchemaWarnings` existir e nunca chamavam essa função — deram falso negativo (`warnings:
0`) mesmo com o código de produção (`updateObsidianGraph.ts`/`generateHtmlReport.ts`) já correto.
Confirmado isolando a lógica pura num script de debug separado antes de desconfiar do código real.
Lição: sempre que um novo `flagXWarnings` é adicionado aos 3 pontos de chamada oficiais, os scripts
de regeneração manual usados pra depuração precisam do mesmo import — checar isso primeiro da
próxima vez que um "warnings: 0" parecer errado.

**Validado ponta a ponta** contra `orders-api-provider`/`orders-api-consumer`: (1) com sibling
mapeado, mudar só `maxLength` de `Order.customerName` no provider virou `broken` citando o campo e
os dois valores; (2) renomeando o `openapi.yaml` do consumer pra isolar o contrato do provider,
mudar o mesmo campo virou `warning` (amarelo), nunca `broken` — confirmado no diagrama Mermaid, na
nota de integração, na nota do novo `ServiceNode` de contrato isolado, e no relatório HTML (seção
"Avisos de versão", separada de "Problemas encontrados"). Fixture revertida ao baseline saudável
(52 arquivos, 0 problema) ao final, incluindo a remoção manual das notas do `ServiceNode`/edge
isolados (que senão reapareceriam como "removida" quando o sibling volta — mesmo mecanismo de nota
órfã já visto antes com `reporting-service`/`webhook-relay`).

Testes novos: `miniYaml.test.ts` (9), `contractSignature.test.ts` (+7 pra schema extraction),
`contractIntegrity.test.ts` (+6), `contractSchemaWarnings.test.ts` (5) — suíte total foi de 67
para 90.

## Correções pontuais pedidas durante a validação manual (mesma sessão)

- **Log do diff de contrato mais legível**: o formato original combinava as duas declarações numa
  frase só ("... orders-api-consumer declara 'X', orders-api-provider declara 'Y'"). Virou 2 linhas
  (uma por repo) com só o(s) atributo(s) que realmente divergem destacados em vermelho — novo par
  `DIFF_HIGHLIGHT_START`/`END` (caracteres de controle invisíveis) em `contractSignature.ts`,
  `serializeFieldSignatureWithHighlight`/`diffFieldAttributes` calculam o destaque,
  `diffSchemasBetweenRepos` (`contractIntegrity.ts`) gera as 2 linhas. Cada renderizador troca os
  marcadores pelo seu próprio jeito de colorir (`<span style="color:...">` na nota do Obsidian,
  `<span class="diff-highlight">` no HTML) — sempre depois de escapar o resto da linha, nunca antes.
- **Gap real encontrado pelo usuário**: o heading da nota de repo (`# emoji repoId`) usava o emoji
  da LINGUAGEM (`LANGUAGE_META`), não da saúde — Node.js usa 🟢 como emoji de marca, idêntico em
  forma/cor ao "saudável" usado em todo o resto do documento. Um repo Node quebrado mostrava
  "# 🟢 repoId" bem em cima de um resumo de risco e diagrama vermelhos na MESMA nota. Trocado por
  um emoji de severidade real (🟢/🟡/🟠/🔴, `severityEmoji` em `noteTemplates.ts`) — nunca pode
  contradizer o resto da nota porque usa a mesma função (`severityOf`) que já gera a tag/diagrama.
  2 testes de regressão novos em `src/obsidian/noteTemplates.test.ts` (suíte total: 90 → 95).

## Empacotamento pra instalação global + README em inglês

Pedido do usuário: transformar o agente numa "skill global" instalável localmente e consumível por
qualquer ferramenta de IA compatível com MCP (não só Claude Code) — que já era verdade em espírito
(MCP é protocolo aberto), mas faltava a parte prática de instalação sem caminho absoluto hardcoded.

- **`src/server.ts`** ganhou shebang (`#!/usr/bin/env node`) — `tsc` preserva shebang quando é a
  primeira linha do arquivo fonte, confirmado no `dist/server.js` compilado.
- **`package.json`**: novo bin `traceability-agent-mcp` → `dist/server.js` (além do
  `traceability-agent` já existente pro CLI standalone). Depois de `npm link` (ou
  `npm install -g .`), qualquer cliente MCP pode apontar pro comando `traceability-agent-mcp` sem
  caminho absoluto. Testado ponta a ponta nesta sessão: `npm link` → `which traceability-agent-mcp`
  resolve global → processo sobe e fica esperando no stdio (comportamento correto de um MCP server)
  → `npm unlink -g` limpa. `description` do `package.json` também virou inglês, pra combinar com o
  README novo.
- **README.md reescrito em inglês** (decisão do usuário — resto da documentação/comentários do
  projeto continua em português, é uma inconsistência aceita conscientemente pra esse arquivo
  específico, que é a porta de entrada pro público de "qualquer ferramenta de IA"). Traz tabela de
  config genérica de cliente MCP (Claude Code/Desktop, Cursor, Windsurf) além do
  `claude mcp add` específico, e 5 screenshots reais.
- **`~/.claude/skills/traceability/SKILL.md`** atualizado pra usar `traceability-agent-mcp` no
  snippet de registro, com nota de fallback pro caminho absoluto se `npm link` não foi rodado.

**Screenshots reais** (não mockup) em `docs/screenshots/`, gerados via Chrome headless
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --screenshot=...`) contra
o `generate_html_report` de verdade da fixture `rePo_testes`, com um cenário combinado reconstruído
especificamente pra essas capturas (shared-utils renomeado → quebra; cascade em payment-processor;
webhook-relay com versão de dependência bumped → aviso; contrato orders-api com `customerName`
`string`→`number` → quebra de contrato). Recorte preciso feito injetando `<style>` com seletores
CSS (`.page > section:nth-of-type(N){display:none}`, `.graph-card:not(:nth-of-type(N))`,
`.problem-card:not(:nth-of-type(N))`) numa cópia do HTML antes de tirar o print — mais confiável do
que recortar a imagem depois (`sips -c`/`--cropOffset` tem semântica de ancoragem inconsistente
dependendo do tamanho do crop pedido, não usar pra recorte preciso). Fixture revertida ao baseline
saudável ao final (52 arquivos, 0 problema).

**Decisão pendente do usuário, não resolvida**: license do projeto (README tem seção "License: Not
decided yet" — não escolhi uma licença sem o usuário decidir).

## Novo grupo fixture: `~/projetos/repos_testing/` (Kotlin + Java + Python, Kafka + HTTP + contrato)

Pedido do usuário: um segundo grupo fixture (`repos-testing`, distinto de `rePo_testes`), com
exatamente 3 repos — 1 Kotlin, 1 Java, 1 Python — conectados por fila/Kafka, HTTP, e com contrato
bem definido (campos, tipos, tamanhos) nas chamadas HTTP. Topologia final, todos os 3 tipos de
integração cobrindo os 3 repos:

- **inventory-service** (Kotlin/Gradle) — provider HTTP puro (`POST /stock/reserve`,
  `GET /stock/{sku}`), publica o contrato em `stock-openapi.yaml`.
- **order-service** (Java/Maven) — chama inventory-service via `RestTemplate` (consumidor do
  contrato `stock-openapi.yaml`, cópia idêntica na raiz deste repo); publica Kafka
  `orders.created` via `kafkaTemplate.send(...)`; expõe `PATCH /orders/{orderId}/status`, provider
  do contrato `order-status-openapi.yaml`.
- **shipping-service** (Python/pip) — consome `orders.created` via `confluent_kafka`
  (`Consumer(...).subscribe([...])`); chama order-service via `requests.patch(...)` (consumidor do
  contrato `order-status-openapi.yaml`, cópia idêntica na raiz deste repo).

6 integrações detectadas, todas saudáveis: 2 HTTP, 2 Kafka (publish+consume no mesmo tópico), 2
contract_reference. Validado rodando `update_obsidian_graph`+`generate_html_report` de verdade
contra esse config (script de regeneração análogo aos já usados pra `rePo_testes`) e conferindo o
diagrama renderizado via Chrome headless.

**2 bugs reais achados montando esse fixture** (não do domínio de negócio, da própria mecânica de
detecção — documentados aqui pra não repetir):
1. `scanCodePatterns`/`scanTopicPatterns` só resolvem a URL/tópico quando ela está na MESMA LINHA
   do identificador que disparou o match (`RestTemplate`, `kafkaTemplate.send`, etc.) — uma chamada
   formatada em múltiplas linhas (comum em código real bem formatado) faz o sinal virar
   `unresolved` silenciosamente, sem erro. Não é bug do agente (é uma limitação conhecida e
   consciente do design, evita ter que rastrear string entre linhas), mas É fácil de esquecer
   escrevendo fixture nova — `InventoryClient.java`/`order_status_client.py` precisaram virar
   chamada de uma linha só.
2. `CONTRACT_FILE_PATTERN` (`scanUtils.ts`) exige que o NOME do arquivo termine literalmente em
   `openapi.yaml`/`openapi.yml`/`swagger.json`/`.proto`/`.avsc` — um nome descritivo como
   `stock-api.yaml` não bate (não termina em "openapi.yaml"). Como o regex não tem `^`, um nome
   como `stock-openapi.yaml` bate normalmente (termina com o sufixo exigido) — e sufixos
   DIFERENTES por par de contrato (`stock-openapi.yaml` vs `order-status-openapi.yaml`) são
   necessários quando um mesmo repo (`order-service`, aqui) participa de DOIS contratos distintos
   com repos diferentes — `contractBasename` casa só pelo nome final do arquivo, então dois
   arquivos chamados exatamente `openapi.yaml` no mesmo repo colidiriam num grupo só.

**Detecção de Kafka em Python — não existia, implementada nesta sessão.** `pythonPipAdapter.ts`
tinha sinal de HTTP (`requests`/`httpx`) e de contrato, mas NENHUM de fila — só foi notado ao tentar
montar este fixture. Novo `QUEUE_TOPIC_RULES`:
- publish: `.produce("topic", ...)` — verbo específico do `confluent-kafka`, não genérico o
  suficiente pra colidir com outra coisa.
- consume: `KafkaConsumer("topic", ...)` (tópico como 1º argumento posicional do construtor,
  `kafka-python`) OU `.subscribe(["topic"])` (mesmo nome de método em `confluent-kafka` E
  `kafka-python`).
- **Gap documentado, de propósito**: `kafka-python`'s `producer.send(...)` NÃO é coberto — `.send(`
  é comum demais fora de contexto Kafka (socket, sessão, sinal) pra virar regex sem contexto entre
  linhas (mesmo espírito do gap do `sarama` em Go, do `RestTemplate`/stub em Java).
- 7 testes novos em `src/adapters/pythonPipAdapter.test.ts` (não existia teste nenhum pra esse
  adapter antes) — suíte total: 95 → 102.

## Bug real encontrado pelo usuário: colisão silenciosa de nota entre grupos diferentes no mesmo vault

O usuário reportou: rodar `update_obsidian_graph` no grupo novo `repos-testing` fez o Obsidian
"trazer" grafos do `rePo_testes`. Causa raiz confirmada: o vault é compartilhado entre TODOS os
grupos rastreados na máquina (proposital — é o que viabiliza a visão macro em `index.md`), mas o
nome do arquivo de nota de repo/serviço/integração usa só o id (`repoId`/`serviceId`/`edgeId`),
sem o `groupId`. Como `repos-testing` tem repos chamados `order-service` (Java) e
`inventory-service` (Kotlin) — e `rePo_testes` já tinha um `order-service` (Java, original desde o
início da sessão) e um `inventory-service` (Go, do lote Go/C#/PHP/Rust) — `update_obsidian_graph`
do `repos-testing` sobrescreveu `Repos/order-service.md` e `Repos/inventory-service.md` do
`rePo_testes` silenciosamente, sem nenhum aviso. Confirmado inspecionando o campo `group:` do
frontmatter das notas afetadas antes de corrigir.

**Correção pedida e implementada**: antes de sobrescrever uma nota de repo/serviço/integração,
`writeMerged` (`src/obsidian/obsidianWriter.ts`) agora lê o `group:` do frontmatter da nota JÁ
EXISTENTE — se pertencer a um grupo DIFERENTE do que está gerando agora, a gravação é recusada (o
conteúdo antigo fica intacto) e uma mensagem descritiva é acumulada em `collisions`. A nota de
Grupo (`Groups/<groupId>.md`) fica de fora do guard de propósito — já é namespaced pelo próprio
nome do arquivo, nunca colide. `writeGraphToVault` agora retorna `{ filesWritten, collisions }`
(era só `filesWritten`); `update_obsidian_graph` inclui `collisions` na resposta da tool só quando
não-vazio, com instrução na descrição da tool pra avisar o usuário e sugerir renomear o id num dos
dois configs. 3 testes novos em `src/obsidian/obsidianWriter.test.ts` (não existia teste nenhum pra
esse arquivo antes) — suíte total: 102 → 105.

**Recuperação do dano já feito**: o usuário já tinha contornado o sintoma renomeando os ids
colidentes pra `order-service-legado`/`inventory-service-legado` no `.traceability/config.json` do
`rePo_testes` (paths continuam apontando pras mesmas pastas `./order-service`/`./inventory-service`
— só o `id` mudou). Rodei `update_obsidian_graph` do `rePo_testes` de novo com esse config já
corrigido — as notas `-legado` foram recriadas corretamente sob `group: "repo-testes"`, sem
colisão (0 collisions), e as notas `order-service.md`/`inventory-service.md` originais continuam
intocadas sob `group: "repos-testing"`. Nenhum conteúdo foi perdido de fato — as notas afetadas são
100% regeneradas a partir do código-fonte a cada scan, então sobrescrever com o conteúdo de outro
grupo não destruiu nada que uma nova varredura não recriasse (o único risco real seria uma anotação
manual do usuário na cauda pós-`AUTO-GENERATED:END` dessas 2 notas específicas, que não existia).

**Limitação que continua existindo, de propósito**: o guard bloqueia SILENCIOSAMENTE indefinidamente
(nunca reivindica o nome de volta pro novo grupo automaticamente) até o usuário resolver a colisão
renomeando um dos dois ids — isso é intencional (evitar ping-pong de sobrescrita entre execuções
alternadas dos dois grupos), mas significa que, se o usuário genuinamente QUISER trocar a quem um
id pertence, precisa apagar a nota manualmente primeiro.

## Vault dedicado por grupo (`vaultPath` no config) — pedido logo depois, mesma sessão

O guard de colisão (acima) evita corromper dado, mas não separa de verdade os projetos — o usuário
pediu isso explicitamente: rodar o scan de um projeto não pode "trazer" nada de outro. Apresentei 3
opções (vault próprio por grupo / subpasta por grupo dentro do mesmo vault / só melhorar o filtro
mantendo tudo junto) via pergunta direta — escolhida a primeira.

**`GroupConfig` ganhou `vaultPath?: string`** (`src/config/groupConfig.ts`) — resolvido relativo ao
diretório do config (mesma função `resolveRelative` já usada por `path`/`manifestPath`). Precedência
em toda tool que grava no vault (`update_obsidian_graph`, `generate_html_report`,
`generate_impact_report`): `vaultPath` explícito da chamada > `config.vaultPath` > `DEFAULT_VAULT_PATH`
compartilhado. `generate_impact_report` não passa por `analyzeGroup` (usa `runImpactCheck`, que só
devolve o `ImpactDiff`) — chama `loadGroupConfig(configPath)` separadamente só pra ler o `vaultPath`,
sem duplicar a análise pesada. `generate_overview_graph` não muda de assinatura (não é atrelada a
um grupo específico).

**A parte que realmente evita a mistura**: `scanAllGroups` (`src/obsidian/overviewWriter.ts`), usada
pela visão macro (`index.md`), agora resolve o `vaultPath` de CADA grupo registrado no
`~/.traceability-agent/registry.json` (`config.vaultPath ?? DEFAULT_VAULT_PATH`) e só inclui o grupo
se esse valor bater com o vault que está sendo escrito agora (`path.resolve` dos dois lados antes de
comparar). Sem isso, um grupo com vault próprio ainda vazaria pra dentro do `index.md` de QUALQUER
outro vault, já que o registry é global por design (só um índice de "quais configs existem na
máquina", nunca definiu onde cada um vive).

**Não escrevi teste automatizado pra esse filtro** — `REGISTRY_PATH` (`~/.traceability-agent/
registry.json`) é uma constante calculada uma vez no load do módulo (`path.join(os.homedir(), ...)`),
não dá pra mockar `os.homedir()` depois sem um refactor pra injetar o caminho (fora de escopo aqui).
Validado manualmente ponta a ponta contra os 2 fixtures reais em vez disso (mesmo padrão de
validação usado a sessão inteira): dei ao `repos_testing` um `vaultPath: "./vault"` próprio,
confirmei que o `index.md` desse vault dedicado só lista `repos-testing`, e que o vault compartrilhado
do `rePo_testes` não lista mais `repos-testing` nenhum. Limpei manualmente as notas órfãs que
`repos_testing` tinha deixado no vault compartilhado de antes dessa mudança (`Repos/order-service.md`,
`Repos/inventory-service.md`, `Repos/shipping-service.md`, `Groups/repos-testing.md`, e as
integrações relacionadas) — eram resíduo de quando ainda usava o vault padrão, não voltam a ser
escritas lá porque o grupo migrou de vault.

**Achado lateral, não relacionado ao vaultPath**: durante essa validação, `order-status-openapi.yaml`
do `shipping-service` e do `order-service` (`repos_testing`) estavam divergentes de verdade — o
`shipping-service` tinha `# - orderId` (comentado) no lugar de `- orderId` em `required`, causando
um `broken` real detectado corretamente pelo diff de contrato. Não identifiquei quando essa
divergência foi introduzida (não foi uma ação pedida); corrigido pra manter as duas cópias
idênticas de novo, sem relação com a mudança de vault. **Reapareceu sozinha** numa validação
seguinte, já depois do namespacing por grupo (abaixo) — o Edit tool avisou "arquivo modificado em
disco desde a última leitura" na segunda correção, confirmando que algo fora desta sessão tocou o
arquivo entre as duas vezes. Não investiguei a causa (fora de escopo do que foi pedido), só corrigi
de novo; vale ficar de olho se esse arquivo específico voltar a divergir sozinho outra vez.

## Namespacing por grupo elimina a colisão DE VEZ (`Repos/<groupId>/<repoId>.md`) — pedido logo depois, mesma sessão

O guard de colisão + `vaultPath` opcional (acima) foram apresentados como 2 redes de segurança, mas
nenhuma delas eliminava a POSSIBILIDADE de colisão — só evitava virar corrupção silenciosa, ou
exigia lembrar de configurar `vaultPath` em todo grupo novo. O usuário perguntou diretamente "como
resolver isso de vez" — expliquei a única forma estrutural (namespacing por pasta) e o custo real
dela (todo wikilink vira caminho completo; os 2 vaults existentes precisam ser regenerados do
zero), confirmei via pergunta direta, e implementei.

**Mudança de caminho** (`src/obsidian/obsidianWriter.ts`): `Repos/<repoId>.md` →
`Repos/<groupId>/<repoId>.md`, e o mesmo para `Services/`/`Integrations/`. `Groups/<groupId>.md`
fica de fora — já é namespaced pelo próprio nome do arquivo, nunca precisou disso. Dois grupos com
o mesmo repoId agora escrevem em arquivos **fisicamente diferentes** — o guard de colisão anterior
continua existindo, mas vira uma segunda camada de defesa quase inatingível na prática (só dispara
se dois configs DIFERENTES, de projetos não relacionados, coincidirem tanto no `groupId` quanto no
`repoId` — o namespacing por pasta já filtra o caso mais comum, que era só o `repoId` coincidir).

**A parte cara**: o Obsidian resolve `[[nome]]` pelo nome do arquivo em TODO o vault, não por pasta
— um link curto fica ambíguo assim que dois arquivos com o mesmo nome existem em pastas diferentes.
Todo wikilink em `src/obsidian/noteTemplates.ts` (o arquivo inteiro é essencialmente wikilinks)
virou caminho completo a partir da raiz do vault, com alias pra continuar exibindo só o id:
`[[Repos/<groupId>/<repoId>|<repoId>]]`. Novos helpers `repoLink`/`serviceLink`/`integrationLink`/
`groupLink` (esse último sem mudança nenhuma — `Groups/<groupId>.md` continua flat) substituem
todo `[[${id}]]` cru do arquivo. Um caso exigiu mais cuidado: `renderIntegrationNote`'s
`edge.source`/`edge.target` (e o `otherRepo` de `renderChangeEntry`/`diff.blastRadius`/
`dependentsToNotify` em `renderImpactReport`) podem ser um repoId OU um serviceId, sem o contexto
completo do grafo à mão pra checar — resolvido com um helper `nodeLink` que decide pela heurística
`id.startsWith("svc_")` (todo `ServiceNode.id` é construído como `svc:<tipo>:<valor>` sanitizado
antes de virar nome de arquivo — nenhum repoId real bate nesse prefixo).

**Arquivos que liam caminho direto do vault também precisaram mudar** (`removedEdgeDetector.ts`):
`listRemovedEdges`/`reconstructMissingServiceNodes` agora escaneiam `Integrations/<groupId>/` e
`Services/<groupId>/` (não mais a pasta toda) — a checagem de `group:` no frontmatter, que antes
era o ÚNICO filtro, virou uma segunda camada de defesa (nota plantada na subpasta errada, manual ou
resquício de versão anterior). `markIntegrationNoteRemoved` ganhou `groupId` como parâmetro
(assinatura mudou, único call site é `obsidianWriter.ts`). `annotateIntegrationNote`/
`annotateAffectedNotes` também passaram a usar `diff.group` pra montar o caminho.

**Testes reescritos, não só adicionados**: `removedEdgeDetector.test.ts` e `obsidianWriter.test.ts`
tinham fixtures que escreviam nota "achatada" direto — precisaram ser reescritos pra escrever na
subpasta certa (`Integrations/repo-testes/...`), não só ganhar testes novos. O teste de colisão
mais importante de antes ("dois grupos com o mesmo repoId colidem") teve sua PREMISSA invalidada
pela própria correção — virou "dois grupos com o mesmo repoId gravam em arquivos separados, SEM
colisão nenhuma" (exatamente o resultado esperado da mudança), com um teste novo cobrindo o caso
residual que o guard ainda protege (nota plantada manualmente com `group:` divergente na subpasta
certa). Suíte total: 105 → 107.

**Migração dos 2 vaults reais**: apaguei `Repos/`/`Services/`/`Integrations/`/`Groups/` inteiros de
ambos os vaults (conteúdo 100% auto-gerado, sem anotação manual nesses fixtures) e rodei
`update_obsidian_graph`/`generate_html_report` de novo em cada um pra recriar tudo já no formato
namespaced. Limpei também resíduos de `Reports/` que `repos_testing` tinha deixado no vault
compartilhado de antes de ganhar `vaultPath` próprio (`html-report__repos-testing.html` e as
versões arquivadas, `impact-report__shipping-service.md`) — `Reports/` não faz parte do namespacing
por pasta (já é namespaced pelo nome do arquivo, `<tipo>__<groupId>.<ext>`), mas esses arquivos
específicos eram órfãos genuínos da migração de vault da sessão anterior, não do namespacing em si.
`.obsidian/workspace.json` (cache de abas abertas do próprio Obsidian) ainda menciona
"repos-testing" — inofensivo, não é dado do agente, não mexi.

## `vaultPath: "./vault"` virou o padrão recomendado pra todo projeto novo — pedido logo depois, mesma sessão

Depois de explicar que `vaultPath` era opt-in (só o `repos_testing` tinha), o usuário pediu pra
virar o comportamento PADRÃO: todo repositório/grupo que o agente escanear pela primeira vez deve
ganhar `"vaultPath": "./vault"` automaticamente no `.traceability/config.json`.

**Onde isso realmente se aplica**: não existe nenhuma tool/código do agente que CRIA o
`.traceability/config.json` do zero — isso sempre foi delegado à IA que chama as tools, guiada pela
Skill (`scan_repository` em cada repo + escrever o config à mão, conforme a Seção 1 do
`SKILL.md`). Então o único lugar real pra fixar esse "comportamento padrão" é a própria Skill:

- **`~/.claude/skills/traceability/SKILL.md`**: Seção 1 agora instrui explicitamente incluir
  `"vaultPath": "./vault"` no template de config, com a orientação de só omitir se o usuário pedir
  que aquele projeto especificamente entre no vault compartilhado. Seção 3 (macro vs. micro)
  atualizada pra deixar claro que a visão macro (`index.md` combinando vários sistemas) agora só
  acontece quando o usuário pede explicitamente pra 2+ projetos compartilharem o vault padrão —
  deixou de ser automático, já que o padrão agora é cada projeto isolado no próprio vault.
- **README.md**: exemplo principal de config já mostra `vaultPath` incluído; nova seção "Sharing
  one vault across projects (opt-in)" documenta como e quando fazer o oposto (omitir o campo).

**Retrofit dos 2 fixtures existentes**, pra consistência com a nova convenção (não estritamente
pedido — a instrução era sobre projetos futuros — mas fazia sentido deixar as duas demos already
seguindo o novo padrão): adicionei `"vaultPath": "./vault"` no `.traceability/config.json` do
`rePo_testes` também (o `repos_testing` já tinha desde a sessão anterior) e migrei — `rePo_testes`
agora escaneia normalmente e escreve em `~/projetos/rePo_testes/vault/`, próprio, em vez do vault
compartilhado. Limpei os resíduos que sobraram no vault compartilhado (`~/ObsidianVaults/
traceability-vault/`): apaguei `Repos/`, `Services/`, `Integrations/`, `Groups/` inteiros (recriados
vazios) e só os ponteiros "atuais" (sem timestamp) de `Reports/` que ficaram órfãos
(`html-report__repo-testes.html`, `impact-report__{billing-service,fulfillment-service,
order-service}.md`) — **deliberadamente NÃO apaguei o histórico arquivado com timestamp** em
`Reports/` (mais de 100 arquivos `<timestamp>__html-report__repo-testes.html` acumulados a sessão
inteira, geridos por `writeCurrentAndArchivePrevious`) — é registro histórico real de todo o
desenvolvimento desta sessão, apagar isso sem pedido explícito seria destrutivo demais. Confirmado
por código (`writeOverviewToVault` chamado direto contra o vault compartilhado) que ele agora lista
ZERO grupos — nem `repo-testes` nem `repos-testing` apontam mais pra lá.

O script de regeneração manual usado a sessão inteira (`regen.mjs`, fora do repo do agente)
também tinha o mesmo bug de sempre — hardcoded `DEFAULT_VAULT_PATH`, ignorando `config.vaultPath` —
corrigido pra espelhar a precedência real da tool (mesmo padrão já usado em `regen-repos-testing.mjs`
desde a mudança anterior).

## Próximos passos sugeridos (nada disso foi pedido ainda, só ideias em aberto)

- Publicar o pacote no npm de verdade, se quiser compartilhar com outras máquinas/pessoas.
- Checagem de integridade para HTTP/fila (ex: schema de payload mudou) — hoje só existe pra
  dependência de artefato (`published_artifact_dependency`) e, desde esta sessão, pra contrato
  OpenAPI/Swagger (`contract_reference`, ver seção acima). `.proto`/`.avsc` e payload de
  HTTP/fila em si continuam sem checagem de conteúdo.
- Papel explícito provider/consumer por repo na config, pra `checkContractIntegrity` distinguir
  adição segura de remoção que quebra de verdade (hoje trata as duas como divergência, ver
  limitação documentada acima).
- Implementar de fato os 3 gatilhos dev-time desenhados na Fase 8 do plano (tool MCP pro agente de
  código, git hook, gate de CI) — prioridade de qual primeiro ainda não decidida.
- MVP2 (explicitamente fora de escopo por enquanto): acionar `generate_regression_tests`
  automaticamente quando `analyze_impact` encontra uma quebra de verdade.
