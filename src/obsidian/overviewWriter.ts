import fs from "node:fs";
import path from "node:path";
import { analyzeGroup } from "../config/groupAnalysis.js";
import { listRegisteredGroups, removeGroupFromRegistry } from "../config/groupConfig.js";
import { DEFAULT_VAULT_PATH } from "../config/vaultConfig.js";
import { applyCascadingImpact } from "../graph/cascadeImpact.js";
import { findConnectedComponents } from "../graph/connectedComponents.js";
import { loadRenderBaseline } from "../graph/graphSnapshot.js";
import { flagContractSchemaWarnings } from "../graph/contractSchemaWarnings.js";
import { flagVersionWarnings } from "../graph/versionWarnings.js";
import type { OverviewGroup } from "./mermaidRenderer.js";
import { renderOverviewGraph } from "./mermaidRenderer.js";
import { listRemovedEdges, reconstructMissingServiceNodes } from "./removedEdgeDetector.js";

type GroupSummary = OverviewGroup;

/**
 * Escaneia todos os projetos já registrados (via update_obsidian_graph, em qualquer diretório) no
 * índice leve ~/.traceability-agent/registry.json — o pacote do agente não guarda mais os configs
 * dos projetos rastreados, cada um mora no próprio projeto (.traceability/config.json).
 */
/**
 * `groups`: um resumo POR GRUPO/CONFIG registrado — usado na lista "Aplicações rastreadas" (cada
 * grupo tem exatamente uma linha, com a contagem agregada de todos os repos/edges dele).
 * `diagramGroups`: um resumo POR COMPONENTE CONECTADO — usado no diagrama. Um grupo cujos repos
 * não têm NENHUMA integração entre si (mesma pasta/config, aplicações independentes) vira mais de
 * uma caixa aqui, cada uma rotulada "<groupId> — Aplicação N", em vez de uma caixa só que sugere
 * (incorretamente) que tudo ali dentro é uma única aplicação coesa.
 */
function scanAllGroups(vaultPath: string): { groups: GroupSummary[]; diagramGroups: OverviewGroup[] } {
  const groups: GroupSummary[] = [];
  const diagramGroups: OverviewGroup[] = [];
  const targetVaultPath = path.resolve(vaultPath);
  for (const entry of listRegisteredGroups()) {
    let config, snapshot;
    try {
      ({ config, snapshot } = analyzeGroup(entry.configPath));
    } catch {
      removeGroupFromRegistry(entry.configPath); // config foi movida/apagada, ou repo sem path/manifestPath; limpa o registro
      continue;
    }
    // Um grupo com vault PRÓPRIO (campo "vaultPath" no .traceability/config.json) nunca aparece na
    // visão macro de outro vault — nem do vault compartilhado padrão, nem do vault dedicado de
    // OUTRO grupo. Sem esse filtro, qualquer grupo registrado (em QUALQUER vault) vazava pra dentro
    // do index.md de todo mundo, já que o registry (~/.traceability-agent/registry.json) é global
    // por design (só serve de índice de "quais configs existem", não define onde cada um vive).
    const groupVaultPath = path.resolve(config.vaultPath ?? DEFAULT_VAULT_PATH);
    if (groupVaultPath !== targetVaultPath) continue;
    // Só LÊ a baseline (nunca salva) — quem avança é sempre update_obsidian_graph/generate_html_report,
    // pra não fazer o aviso "sumir" do Mapa geral quando ele roda logo depois de já ter avançado a
    // baseline do grupo atual dentro do mesmo update_obsidian_graph.
    const baseline = loadRenderBaseline(config.configPath);
    snapshot.edges = flagVersionWarnings(snapshot.edges, baseline);
    snapshot.edges = flagContractSchemaWarnings(snapshot.edges, baseline);

    const currentEdgeIds = new Set(snapshot.edges.map((edge) => edge.id));
    const removedEdges = listRemovedEdges(vaultPath, config.groupId, currentEdgeIds);
    // Mesmo caso do writeGraphToVault: um recurso de infra pode sumir por completo da varredura
    // (não só a edge) — sem reconstruir o ServiceNode a partir da nota antiga, o "Mapa geral" perde
    // o hexágono/rótulo amigável desse nó assim que uma edge removida ainda o referencia.
    const currentServiceIds = new Set(snapshot.serviceNodes.map((node) => node.id));
    const missingServiceNodes = reconstructMissingServiceNodes(vaultPath, config.groupId, currentServiceIds);
    const allServiceNodes = [...snapshot.serviceNodes, ...missingServiceNodes];
    const allEdges = applyCascadingImpact(
      [...snapshot.edges, ...removedEdges],
      snapshot.repos.map((repo) => repo.repoId),
    );

    groups.push({
      groupId: config.groupId,
      repos: snapshot.repos.map((repo) => ({ repoId: repo.repoId, language: repo.language })),
      serviceNodes: allServiceNodes,
      edges: allEdges,
    });

    const repoIds = snapshot.repos.map((repo) => repo.repoId);
    const serviceNodeIds = allServiceNodes.map((node) => node.id);
    const components = findConnectedComponents(repoIds, serviceNodeIds, allEdges);
    if (components.length <= 1) {
      diagramGroups.push({
        groupId: config.groupId,
        repos: snapshot.repos.map((repo) => ({ repoId: repo.repoId, language: repo.language })),
        serviceNodes: allServiceNodes,
        edges: allEdges,
      });
      continue;
    }

    const reposById = new Map(snapshot.repos.map((repo) => [repo.repoId, repo]));
    const serviceNodesById = new Map(allServiceNodes.map((node) => [node.id, node]));
    components.forEach((component, index) => {
      diagramGroups.push({
        groupId: config.groupId,
        label: `${config.groupId} — Aplicação ${index + 1}`,
        componentKey: `${config.groupId}__app${index + 1}`,
        repos: component.repoIds
          .map((id) => reposById.get(id))
          .filter((repo) => repo !== undefined)
          .map((repo) => ({ repoId: repo.repoId, language: repo.language })),
        serviceNodes: component.serviceNodeIds
          .map((id) => serviceNodesById.get(id))
          .filter((node) => node !== undefined),
        edges: component.edges,
      });
    });
  }
  return { groups, diagramGroups };
}

function renderIndexContent(groups: GroupSummary[], diagramGroups: OverviewGroup[]): string {
  const appList = groups.length
    ? groups
        .map((g) => {
          const activeCount = g.edges.filter((edge) => edge.status === "active").length;
          const impactedCount = g.edges.length - activeCount;
          const repoWord = g.repos.length === 1 ? "repositório" : "repositórios";
          const edgeWord = activeCount === 1 ? "integração saudável" : "integrações saudáveis";
          const impactedSuffix = impactedCount > 0 ? `, ${impactedCount} impactada${impactedCount > 1 ? "s" : ""}` : "";
          return `- [[${g.groupId}]] (${g.repos.length} ${repoWord}, ${activeCount} ${edgeWord}${impactedSuffix})`;
        })
        .join("\n")
    : "(nenhum projeto rastreado ainda — rode update_obsidian_graph a partir de um projeto com .traceability/config.json)";

  const overviewGraph = diagramGroups.length
    ? renderOverviewGraph(diagramGroups, { showTypeLabel: true, colorHealthyNodes: true })
    : "_Nenhuma aplicação para desenhar ainda — crie `.traceability/config.json` na raiz de um projeto e rode update_obsidian_graph a partir de lá._";

  return `---
type: moc
tags: [moc, index]
---

# Traceability Vault

Mapa de conteúdo (MOC) do sistema de rastreabilidade de integrações entre repositórios.

## Aplicações rastreadas
${appList}

## Mapa geral (todas as aplicações)
_Visão macro: cada caixa é uma aplicação (grupo de repositórios que evoluem juntos), nomeada pelo seu grupo/repositório principal. Verde = saudável, amarelo = aviso (algo mudou, ex: versão — sem quebra confirmada), laranja = impacto em cascata, vermelho = quebra direta — vale tanto para arestas quanto para nós (a cor se propaga até onde o impacto realmente alcança na cadeia)._

${overviewGraph}

Para a visão micro (vizinhos diretos de UM repositório, internos e externos ao grupo), veja o diagrama na própria nota do repositório em \`Repos/<groupId>/<repoId>.md\`.

## Seções
- \`Repos/<groupId>/\` — uma nota por repositório (nó do grafo) DESTE grupo, com a visão micro (ego-graph) embutida — cada grupo tem sua própria subpasta, pra dois grupos nunca colidirem mesmo reusando o mesmo id de repositório
- \`Integrations/<groupId>/\` — uma nota por integração detectada entre repositórios deste grupo (aresta do grafo)
- \`Groups/\` — uma nota por grupo/aplicação, com a visão macro daquele grupo isolado
- \`Reports/\` — relatórios de análise de impacto e relatórios HTML gerados a cada scan

## Como usar
Abra o Graph View do Obsidian para visualizar repositórios (nós) conectados pelas integrações detectadas (arestas/nós intermediários). Filtre por tag \`#repo\`, \`#integration\` ou \`#impact-report\` para focar em um tipo específico. Para ver a cor real das arestas (o Graph View nativo só colore nós), use os diagramas Mermaid embutidos nas notas — abra em modo Leitura.

## Legenda de cores

**Arestas (integrações):**
| Cor | Significado |
|---|---|
| 🟢 Verde | Integração saudável e resolvida. |
| 🟡 Amarelo | Integração **com aviso** — algo mudou desde a última varredura (ex: versão da dependência), mas a integração continua ativa; o repositório dependente pode continuar funcionando normalmente com a versão anterior. Vale uma revisão, não é uma quebra. |
| 🟠 Laranja | Integração **impactada em cascata** — estruturalmente íntegra, mas a montante existe uma quebra/remoção que compromete o que ela deveria receber. |
| 🔴 Vermelho (linha sólida) | Integração **corrompida** — quebra direta. |
| 🔴 Vermelho tracejado | Integração **removida** — detectada antes, não apareceu mais na última varredura (nome de tópico/endpoint/dependência pode ter mudado só de um lado). |
| Cinza tracejado (visão micro) | Integração externa ao grupo, não resolvida para nenhum repo rastreado. |

**Nós (repositórios e serviços de infra):**
| Cor | Significado |
|---|---|
| 🟢 Verde (tag \`#ok\`) | Sem problema — nenhuma integração dele está corrompida, removida, em cascata, ou com aviso de versão. |
| 🟡 Amarelo (tag \`#warning\`) | **Não** tem quebra nem impacto em cascata, mas alguma integração dele mudou de versão desde a última varredura — vale uma revisão. |
| 🟠 Laranja (tag \`#impacted\`) | **Não** tem quebra direta, mas está a jusante ou depende de algo que está — só é atingido em cascata (o alerta chega até ele, mas o problema não é dele). |
| 🔴 Vermelho (tag \`#broken\`) | Participa **diretamente** de uma integração corrompida ou removida. |

No Graph View nativo do Obsidian (\`.obsidian/graph.json\`), essas mesmas tags controlam a cor do nó — o tipo de cada integração (dependência, HTTP, fila...) não colore mais nada, só continua disponível como tag de filtro.
`;
}

/** Escaneia todos os grupos configurados e regenera o index.md (MOC) do vault por completo. */
export function writeOverviewToVault(vaultPath: string): { filePath: string; groups: GroupSummary[] } {
  const { groups, diagramGroups } = scanAllGroups(vaultPath);
  const filePath = path.join(vaultPath, "index.md");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(filePath, renderIndexContent(groups, diagramGroups), "utf8");
  return { filePath, groups };
}
