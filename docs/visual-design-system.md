# Sistema visual do traceability-agent — modelo de referência

Este documento descreve o esquema visual definido para o agente (cores, rótulos, tags) depois de
várias rodadas de ajuste com dados reais. Serve de modelo para replicar o mesmo padrão em qualquer
grupo/projeto futuro rastreado pelo agente — o esquema é o mesmo em todo lugar, não precisa ser
redecidido a cada novo grupo.

## 1. Esquema de cores — "farol"

Uma única lógica de 4 cores, aplicada de forma idêntica a **nós** (repositórios e nós de serviço)
e **arestas** (integrações), em **todos** os lugares onde o grafo aparece:

| Cor | Hex | Significado |
|---|---|---|
| 🟢 Verde | `#2e7d32` | Sem problema — nó ou aresta saudável. |
| 🟡 Amarelo | `#f9a825` | **Aviso** (`versionWarning`) — algo mudou desde a última varredura (ex: versão de uma dependência), mas a integração continua `active`; o repositório dependente pode continuar funcionando normalmente com a versão anterior. Vale uma revisão, não é uma quebra. |
| 🟠 Laranja | `#ef6c00` | Impacto em cascata (`impacted`) — estruturalmente íntegro, mas a montante (ou a jusante, pra quem depende) existe uma quebra que compromete o funcionamento real. |
| 🔴 Vermelho | `#e53935` | Quebra direta — integração corrompida (`broken`) ou que sumiu numa varredura (`removed`). |

Constantes em `src/graph/colorPalette.ts` (`ACTIVE_HEX_COLOR`, `WARNING_HEX_COLOR`,
`IMPACTED_HEX_COLOR`, `BROKEN_HEX_COLOR`). Cinza (`#9aa5a6`) é usado só como neutro/fallback (nó
externo não resolvido, ou base do Graph View nativo antes de qualquer classificação — na prática
quase nunca aparece, porque toda nota de repo/integração sempre recebe uma tag de status).

**`versionWarning` é ortogonal a `EdgeStatus`, não um 5º valor dele.** `EdgeStatus` continua sendo
só `"active" | "broken" | "removed" | "impacted"` — de propósito, pra não interferir com a lógica de
raiz de cascata em `applyCascadingImpact` (que só considera `broken`/`removed` como origem). Um
aviso de versão é um booleano (`GraphEdge.versionWarning`) calculado por `flagVersionWarnings`
(`src/graph/versionWarnings.ts`) comparando a versão atual de cada edge `active` contra uma
baseline anterior (`.traceability/state/render-baseline.json`, ver `src/graph/graphSnapshot.ts`) —
**nunca** contra o snapshot de `analyze_impact` (esse é avançado só sob pedido explícito; a
render-baseline avança a cada `update_obsidian_graph`/`generate_html_report`, que rodam com muito
mais frequência). Por não ter histórico, `versionWarning` é um marcador de "última vez que alguém
olhou o grafo" — uma vez que qualquer uma dessas duas tools observou a mudança de versão e
regravou a baseline, a próxima renderização não repete o aviso (ao contrário de `broken`/`impacted`,
que persistem até a causa real ser corrigida). `computeNodeSeverities`
(`src/graph/nodeSeverity.ts`) usa o rank `ok < warning < impacted < broken` pra decidir a cor de
cada **nó** a partir de todas as arestas que o tocam.

**Decisão explícita, não reverter sem pedido:** antes disso, cada TIPO de nó (linguagem do repo,
tipo de serviço de infra — Kafka, SQS, Lambda, ECS...) tinha sua própria cor. Com mais tipos
diferentes isso virou ruído visual sem relação com saúde do sistema ("cores demais pra
distinguir de relance"). O tipo continua identificável, só que como **texto**, não cor (ver seção 2).

### Onde a cor é aplicada

- **Diagramas Mermaid** (Group note, ego-graph de cada repo, "Mapa geral" do index.md, e a seção
  "Diagrama de integrações" do relatório HTML) — via `classDef`/`class` no próprio Mermaid.
  `linkStyle` colore a aresta; `classDef healthyNode/brokenNode/impactedNode` colore o nó.
- **Graph View nativo do Obsidian** (`.obsidian/graph.json`, campo `colorGroups`) — já que ele só
  colore nós (não linhas, por limitação do próprio Obsidian — renderizado em canvas). Ver seção 3.
- **Relatório HTML** — mesmo Mermaid, mesmas classes.

## 2. Tipo como texto, não ícone/cor

Cada nó mostra seu tipo entre parênteses numa segunda linha do rótulo, no lugar do emoji que
existia antes:

```
order-service
(java)

notification-handler
(lambda)

payment-processor-svc
(ecs)
```

- Repositório → linguagem real (`java`, `kotlin`, `node`, `python`).
- Nó de serviço → tipo de serviço sem o prefixo `aws-` (`aws-lambda` → `lambda`, `aws-ecs` → `ecs`,
  `kafka` → `kafka`).

Implementado via `MermaidGraphOptions.showTypeLabel` em `src/obsidian/mermaidRenderer.ts` — usado
por **todos** os três renderers (`renderMermaidGraph`, `renderEgoGraph`, `renderOverviewGraph`) e
pelo relatório HTML. Junto com `colorHealthyNodes: true` (aplica a cor verde a todo nó saudável,
que antes ficava sem cor nenhuma quando não havia problema).

```ts
renderMermaidGraph(repoIds, edges, ctx, { showTypeLabel: true, colorHealthyNodes: true });
```

## 3. Vocabulário de tags

Repositórios e integrações usam exatamente as **mesmas 5 tags** de status (antes eram nomes
diferentes por tipo de nota — `at-risk`/`impacted-node` para repos vs `broken`/`impacted` para
integrações — unificado num vocabulário só):

| Tag | Quando |
|---|---|
| `#ok` | Sem problema (nem quebra direta, nem cascata, nem aviso de versão). |
| `#warning` | Sem quebra nem impacto em cascata, mas uma versão referenciada mudou desde a última varredura — vale revisão. |
| `#impacted` | Só atingido em cascata — não é a causa, mas está no caminho do impacto. |
| `#broken` | Participa diretamente de uma integração corrompida. |
| `#removed` | Integração que existia antes e não apareceu na última varredura (só em notas de integração — repo nesse caso vira `#broken`). |

O **tipo** da integração (`published_artifact_dependency`, `outbound_http`, `queue_publish`, etc.)
continua como tag pra filtro/busca no Obsidian, mas **não colore mais nada** — só o status colore.

Implementado em `src/obsidian/noteTemplates.ts` (`renderRepoNote`, `renderServiceNote`,
`renderIntegrationNote`).

## 4. Graph View nativo do Obsidian (`.obsidian/graph.json`)

Dois ajustes, reaplicados a cada `update_obsidian_graph` (função `ensureGraphViewConfig` em
`src/obsidian/graphViewConfig.ts`, chamada de `ensureVaultStructure`):

1. **`colorGroups`** — 7 grupos só, nessa ordem (o Graph View colore pelo primeiro que casar, então
   mais específico vem antes do fallback genérico):
   ```
   tag:#broken     → vermelho
   tag:#removed    → vermelho
   tag:#impacted   → laranja
   tag:#warning    → amarelo
   tag:#ok         → verde
   tag:#repo       → cinza (fallback)
   tag:#integration → cinza (fallback)
   ```
2. **`search`** — `-path:Reports -path:Groups -path:index.md`, excluindo do Graph View as notas que
   não são topologia real (relatórios, nota de grupo, índice). Sem isso, a nota de Grupo aparece
   como um "hub" ligado a todo repo (ela lista `[[repo]]` de todos), poluindo o mapa.

**Limitação conhecida, não é bug:** o Obsidian reescreve o `.obsidian/graph.json` **inteiro**
sempre que o usuário interage com o Graph View (abrir, arrastar, zoom, fechar filtros) — isso apaga
`colorGroups` e `search` juntos. A config é reaplicada automaticamente a cada regeneração do grafo
pelo agente, mas pode resetar de novo se o usuário mexer no Graph View antes da próxima
regeneração. Pra conferir cores sem esse risco, usar os diagramas Mermaid (conteúdo da nota, nunca
reseta) em vez do Graph View nativo.

## 5. Relatório HTML — estrutura da seção de diagrama

`src/reports/htmlReport.ts`, seção "Diagrama de integrações":

- Reaproveita a mesma função geradora Mermaid da nota de Grupo (`renderMermaidGraph`, sem o
  `subgraph` namespaced que só o "Mapa geral" multi-grupo precisa).
- Mermaid.js embutido inline no HTML (`node_modules/mermaid/dist/mermaid.min.js`, lido via
  `import.meta.resolve`) — relatório continua um arquivo único, funciona offline.
- **Zoom**: botões `−`/`100%`/`+`, redimensionam o `<svg>` já renderizado (`width`/`height`
  explícitos, nunca `transform: scale` — isso distorcia o layout numa tentativa anterior).
- **Pan**: arrastar com o mouse move `scrollLeft`/`scrollTop` do container (nunca transform no
  conteúdo) — o Mermaid sempre renderiza no tamanho natural dele, sem nenhuma restrição de
  container durante o render, pra nunca sair distorcido.
- **Ajuste inicial**: ao carregar, o diagrama é escalado (proporção preservada, "object-fit:
  contain") pra caber por inteiro na janela de altura fixa (600px) e centralizado com CSS Grid
  (`place-items: center` — **não** flexbox, que tem um bug conhecido de não conseguir rolar até o
  início de um item centralizado maior que o container, o que passa a importar assim que o zoom
  deixa o diagrama maior que a janela).

## 5.1 Relatório HTML — "Problemas" vs. "Avisos de versão"

Duas seções deliberadamente separadas, não uma lista só:

- **"Problemas encontrados"** (`renderProblems`) — só edges com `status !== "active"`
  (`broken`/`removed`/`impacted`). É o que dirige o pill "N problemas encontrados" do topo.
- **"Avisos de versão"** (`renderVersionWarnings`) — só edges `active` com `versionWarning: true`.
  Fica de fora do pill/contagem de problemas de propósito: um aviso de versão não é uma quebra (a
  integração continua ativa), então misturar as duas listas inflaria "N problemas" com algo que
  ainda funciona.

Tokens CSS (`src/reports/htmlReport.ts`): `--impacted`/`--impacted-soft` (laranja,
`IMPACTED_HEX_COLOR`) e `--warning`/`--warning-soft` (amarelo, `WARNING_HEX_COLOR`) são injetados
diretamente a partir das constantes de `colorPalette.ts` — garante que a cor do chip/tile/linha de
tabela no relatório HTML seja **sempre** a mesma do diagrama Mermaid e do Graph View nativo, sem
risco de divergir numa manutenção futura.

## 6. Onde tudo isso NÃO se aplica

As notas do Obsidian (Group, Repo, index.md) recebiam originalmente ícone de linguagem/serviço +
cor por tipo. Essa distinção foi **removida também nelas** nesta rodada (seções 1–3 valem em
todo lugar agora — Obsidian e relatório HTML usam exatamente o mesmo esquema). Não existe mais
nenhum lugar no agente com o esquema antigo de cor-por-tipo.
