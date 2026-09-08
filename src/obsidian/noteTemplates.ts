import type { RepoAnalysisResult } from "../adapters/types.js";
import { BROKEN_HEX_COLOR, IMPACTED_HEX_COLOR, WARNING_HEX_COLOR } from "../graph/colorPalette.js";
import { findConnectedComponents } from "../graph/connectedComponents.js";
import { DIFF_HIGHLIGHT_END, DIFF_HIGHLIGHT_START } from "../graph/contractSignature.js";
import { EDGE_LABELS } from "../graph/edgeLabels.js";
import type { NodeSeverity } from "../graph/nodeSeverity.js";
import { severityOf } from "../graph/nodeSeverity.js";
import { SERVICE_TYPE_META } from "../graph/serviceTypeMeta.js";
import type { GraphEdge, ServiceNode } from "../graph/types.js";
import type { EdgeDiffEntry, ImpactDiff } from "../impact/diffEngine.js";
import type { GraphRenderContext } from "./mermaidRenderer.js";
import { renderEgoGraph, renderMermaidGraph } from "./mermaidRenderer.js";

export const AUTO_GENERATED_START = "<!-- AUTO-GENERATED:START -->";
export const AUTO_GENERATED_END = "<!-- AUTO-GENERATED:END -->";

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---`;
}

/**
 * Achado real em produção (sessão 2026-09): o vault é compartilhado entre todos os grupos
 * rastreados, mas as notas de repo/serviço/integração eram gravadas achatadas (`Repos/<id>.md`) —
 * dois grupos independentes usando o mesmo id (ex: dois sistemas diferentes com um "order-service"
 * cada um) sobrescreviam a nota um do outro. A correção definitiva foi mover cada tipo de nota pra
 * uma subpasta por grupo (`Repos/<groupId>/<id>.md`) — elimina a colisão estruturalmente, sem
 * depender de configurar um vault dedicado por grupo. Como o Obsidian resolve `[[nome]]` pelo nome
 * do arquivo em TODO o vault (não por pasta), um link curto fica ambíguo assim que dois arquivos
 * com o mesmo nome existem em pastas diferentes — por isso todo wikilink abaixo usa o CAMINHO
 * COMPLETO a partir da raiz do vault, com um alias (`|texto`) pra continuar exibindo só o id.
 * `Groups/<groupId>.md` fica de fora (não precisa, já é namespaced pelo próprio nome do arquivo).
 */
function repoLink(groupId: string, repoId: string): string {
  return `[[Repos/${groupId}/${repoId}|${repoId}]]`;
}

function serviceLink(groupId: string, serviceId: string, displayLabel?: string): string {
  return `[[Services/${groupId}/${serviceId}|${displayLabel ?? serviceId}]]`;
}

function integrationLink(groupId: string, edgeId: string, displayText?: string): string {
  return `[[Integrations/${groupId}/${edgeId}|${displayText ?? edgeId}]]`;
}

function groupLink(groupId: string): string {
  return `[[${groupId}]]`;
}

/** Todo `ServiceNode.id` é construído como `svc:<tipo>:<valor>` e sanitizado (":" -> "_") antes de
 * virar id de nota (ver `sanitizeNoteId`/`getOrCreateServiceNode` em `graphBuilder.ts`) — nenhum
 * repoId real começa com esse prefixo. Usado pra decidir em qual subpasta (Repos/ vs Services/) um
 * id genérico (fonte/alvo de uma edge, ou um id solto vindo do diff de impacto) deve resolver,
 * quando a função não tem o contexto completo do grafo à mão pra checar de verdade. */
function isServiceNodeId(id: string): boolean {
  return id.startsWith("svc_");
}

function nodeLink(groupId: string, id: string): string {
  return isServiceNodeId(id) ? serviceLink(groupId, id) : repoLink(groupId, id);
}

/** Substitui os marcadores de destaque de `serializeFieldSignatureWithHighlight`
 * (`DIFF_HIGHLIGHT_START`/`END`, ver `contractSignature.ts`) por um `<span>` colorido — Obsidian
 * renderiza HTML inline dentro de markdown (mesmo padrão já usado no resumo de risco). */
function highlightDiffMarkdown(line: string): string {
  return line.replaceAll(
    new RegExp(`${DIFF_HIGHLIGHT_START}(.*?)${DIFF_HIGHLIGHT_END}`, "g"),
    `<span style="color:${BROKEN_HEX_COLOR}">$1</span>`,
  );
}

const SEVERITY_EMOJI: Record<NodeSeverity, string> = { ok: "🟢", warning: "🟡", impacted: "🟠", broken: "🔴" };

/** Gap real encontrado em produção: o título da nota de repo usava o emoji da LINGUAGEM
 * (`LANGUAGE_META`), não da saúde — e o emoji de Node.js (🟢) e Kotlin (🟣) são círculos coloridos,
 * iguais em forma ao vocabulário de status usado em todo o resto do documento. Um repo Node
 * quebrado mostrava "# 🟢 orders-api-provider" bem em cima de um resumo de risco vermelho e um
 * diagrama vermelho na mesma nota — parecia contradição, mesmo a tag/cor real estando corretas. Ícone
 * de linguagem já tinha sido removido dos diagramas nesta mesma repo (ver `docs/visual-design-
 * system.md`, seção 6) mas não deste heading — trocado aqui pelo emoji de severidade real, que
 * nunca pode contradizer o resto da nota porque vem da MESMA função (`severityOf`).
 */
function severityEmoji(severity: NodeSeverity): string {
  return SEVERITY_EMOJI[severity];
}

function repoCoordinateList(repo: RepoAnalysisResult): string[] {
  const { groupId, artifactId, packageName } = repo.coordinates;
  if (groupId && artifactId) return [`${groupId}:${artifactId}`];
  if (packageName) return [packageName];
  return [];
}

function impactReason(edge: GraphEdge): string {
  if (edge.status === "broken") return edge.brokenReason ?? "Motivo não especificado.";
  if (edge.status === "impacted") {
    return edge.brokenReason ?? "Impacto em cascata: depende, a montante, de uma integração corrompida ou removida.";
  }
  if (edge.status === "active" && edge.versionWarning) {
    if (edge.version === undefined) {
      // Contrato isolado (sem consumidor mapeado) cujo schema mudou — não é uma versão de
      // dependência, é `contractSchemaFingerprint` divergindo da execução anterior. Ver
      // `flagContractSchemaWarnings`.
      return "O schema deste contrato mudou desde a última varredura — sem nenhum consumidor mapeado hoje pra confirmar impacto real, mas vale revisar se algum repositório fora deste grupo depende dele.";
    }
    return `Versão referenciada mudou para \`${edge.version}\` desde a última varredura — a integração continua ativa (o repositório dependente pode continuar funcionando normalmente com a versão anterior), mas vale revisar se algo mudou de comportamento.`;
  }
  return "Não detectada na varredura mais recente — nome de tópico/endpoint/dependência pode ter mudado só de um lado.";
}

function edgeReasonColor(edge: GraphEdge): string {
  if (edge.status === "impacted") return IMPACTED_HEX_COLOR;
  if (edge.status === "active" && edge.versionWarning) return WARNING_HEX_COLOR;
  return BROKEN_HEX_COLOR;
}

/**
 * Resumo de risco visível assim que a nota é aberta/o nó é clicado: lista cada integração que
 * impacta este repositório (corrompida, removida, impactada em cascata, ou com aviso de versão) com
 * o motivo, na cor mapeada na legenda — vermelho para quebra direta, laranja para impacto em
 * cascata, amarelo para aviso (algo mudou, ex: versão, sem quebra confirmada).
 */
function renderRiskSummary(repoId: string, edges: GraphEdge[], groupId: string): string {
  // Filtra pra edges que realmente tocam este nó (origem ou destino) — sem isso, se o chamador
  // passar a lista completa de edges do snapshot (em vez de só as relacionadas a este nó), o
  // resumo lista integrações de QUALQUER lugar do grafo como se fossem deste nó, com a direção
  // (→/←) calculada errado pra qualquer edge que não toque `repoId`.
  const impacted = edges.filter(
    (edge) => (edge.status !== "active" || edge.versionWarning) && (edge.source === repoId || edge.target === repoId),
  );
  if (impacted.length === 0) return "";

  const lines = impacted.map((edge) => {
    const otherRepo = edge.source === repoId ? edge.target : edge.source;
    const arrow = edge.source === repoId ? "→" : "←";
    return `> - ${integrationLink(groupId, edge.id)} (${repoId} ${arrow} ${otherRepo}) — <span style="color:${edgeReasonColor(edge)}">${impactReason(edge)}</span>`;
  });

  const nodeSeverity = severityOf(edges, repoId);
  const headerColor =
    nodeSeverity === "impacted" ? IMPACTED_HEX_COLOR : nodeSeverity === "warning" ? WARNING_HEX_COLOR : BROKEN_HEX_COLOR;
  const count = impacted.length;
  return [
    `> <span style="color:${headerColor}">⚠️ **${count} integração${count > 1 ? "ões" : ""} impactando este repositório**</span>`,
    ...lines,
    "",
  ].join("\n");
}

export function renderRepoNote(
  repo: RepoAnalysisResult,
  groupId: string,
  outgoingEdges: GraphEdge[],
  incomingEdges: GraphEdge[],
  ctx: GraphRenderContext,
): string {
  const allEdges = [...outgoingEdges, ...incomingEdges];
  const hasBrokenIntegration = allEdges.some((edge) => edge.status === "broken");
  const hasRemovedIntegration = allEdges.some((edge) => edge.status === "removed");
  const hasCascadingImpact = allEdges.some((edge) => edge.status === "impacted");
  const hasVersionWarning = allEdges.some((edge) => edge.status === "active" && edge.versionWarning);
  const severity = severityOf(allEdges, repo.repoId);

  const extraTags = [
    ...(hasBrokenIntegration ? ["has-broken-integration"] : []),
    ...(hasRemovedIntegration ? ["has-removed-integration"] : []),
    ...(hasCascadingImpact ? ["has-cascading-impact"] : []),
    ...(hasVersionWarning ? ["has-version-warning"] : []),
    // Mesmo vocabulário de status usado nas notas de integração (broken/impacted/warning) e nos
    // colorGroups do Graph View — antes eram nomes próprios (at-risk/impacted-node) que exigiam
    // uma entrada de cor separada; "ok" cobre explicitamente o caso saudável, que antes não tinha
    // tag nenhuma (o Graph View só conseguia colorir pelo tag:#repo genérico, sem diferenciar saúde).
    ...(severity === "broken"
      ? ["broken"]
      : severity === "impacted"
        ? ["impacted"]
        : severity === "warning"
          ? ["warning"]
          : ["ok"]),
  ];

  const front = frontmatter({
    type: "repo",
    repoId: repo.repoId,
    group: groupId,
    language: repo.language,
    buildSystem: repo.buildSystem,
    coordinates: repoCoordinateList(repo),
    lastScannedAt: repo.scannedAt,
    tags: ["repo", groupId, repo.language, ...extraTags],
  });

  const renderEdgeLine = (edge: GraphEdge): string => {
    const marker =
      edge.status === "broken"
        ? " 🔴"
        : edge.status === "impacted"
          ? " 🟠"
          : edge.status === "removed"
            ? " 🗑️"
            : edge.status === "active" && edge.versionWarning
              ? " 🟡"
              : "";
    return `- ${integrationLink(groupId, edge.id)} (${EDGE_LABELS[edge.type].label})${marker}`;
  };

  const outgoingList = outgoingEdges.length ? outgoingEdges.map(renderEdgeLine).join("\n") : "(nenhuma detectada nesta versão)";

  const incomingList = incomingEdges.length ? incomingEdges.map(renderEdgeLine).join("\n") : "(nenhuma detectada nesta versão)";

  return [
    front,
    "",
    `# ${severityEmoji(severity)} ${repo.repoId}`,
    "",
    AUTO_GENERATED_START,
    renderRiskSummary(repo.repoId, allEdges, groupId),
    "## Grupo",
    groupLink(groupId),
    "",
    "## Vizinhança (visão micro)",
    "_Relações diretas deste repositório — internas ao grupo (linha colorida), nós de serviço de infra (hexágono) e externas/não resolvidas (linha tracejada cinza)._",
    "",
    renderEgoGraph(repo, outgoingEdges, incomingEdges, ctx, { showTypeLabel: true, colorHealthyNodes: true }),
    "",
    "## Integrações onde este repo é a ORIGEM",
    outgoingList,
    "",
    "## Integrações onde este repo é o ALVO (dependentes)",
    incomingList,
    "",
    `_Último scan: ${repo.scannedAt}_`,
    AUTO_GENERATED_END,
  ].join("\n");
}

/**
 * Nota do nó de serviço de infra (fila/tópico/Lambda/ECS/...) — sem isso, o id do nó (usado como
 * wikilink dentro das notas de integração que o têm como origem/destino, ex:
 * `[[svc_aws-lambda_notification-handler]]`) não resolve pra nenhum arquivo real, e o Graph View
 * nativo mostra um nó "fantasma" que abre em branco ao clicar.
 */
export function renderServiceNote(
  node: ServiceNode,
  groupId: string,
  edges: GraphEdge[],
  repoIds: Iterable<string> = [],
): string {
  const relatedEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const severity = severityOf(edges, node.id);
  const meta = SERVICE_TYPE_META[node.serviceType];

  // Um serviço de infra (fila/tópico/Lambda/...) pode ser tocado por vários repos ao mesmo tempo
  // (ex: um tópico Kafka com 2 consumidores) — sem esta lista, a nota só linka pro grupo genérico
  // (a "pasta" onde tudo é centralizado) e não deixa claro, de cara, a QUAL repositório específico
  // cada integração pertence; é preciso abrir cada edge da lista abaixo e olhar a seta pra descobrir.
  const repoIdSet = new Set(repoIds);
  const relatedRepoIds = [
    ...new Set(
      relatedEdges
        .map((edge) => (edge.source === node.id ? edge.target : edge.source))
        .filter((otherId) => repoIdSet.has(otherId)),
    ),
  ];

  const front = frontmatter({
    type: "service",
    serviceId: node.id,
    serviceType: node.serviceType,
    label: node.label,
    group: groupId,
    tags: [
      "service",
      groupId,
      node.serviceType,
      severity === "broken" ? "broken" : severity === "impacted" ? "impacted" : severity === "warning" ? "warning" : "ok",
    ],
  });

  const renderEdgeLine = (edge: GraphEdge): string => {
    const marker =
      edge.status === "broken"
        ? " 🔴"
        : edge.status === "impacted"
          ? " 🟠"
          : edge.status === "removed"
            ? " 🗑️"
            : edge.status === "active" && edge.versionWarning
              ? " 🟡"
              : "";
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const arrow = edge.source === node.id ? "→" : "←";
    return `- ${integrationLink(groupId, edge.id)} (${EDGE_LABELS[edge.type].label}, ${arrow} ${repoLink(groupId, otherId)})${marker}`;
  };

  const edgeList = relatedEdges.length ? relatedEdges.map(renderEdgeLine).join("\n") : "(nenhuma integração detectada nesta versão)";

  const evidenceList = node.evidence.length
    ? node.evidence
        .map((ev) => `- \`${ev.file}${ev.line ? `:${ev.line}` : ""}\`\n  \`\`\`\n  ${ev.snippet}\n  \`\`\``)
        .join("\n")
    : "(nenhuma evidência registrada)";

  return [
    front,
    "",
    `# ${meta.emoji} ${node.label}`,
    "",
    AUTO_GENERATED_START,
    renderRiskSummary(node.id, edges, groupId),
    "## Grupo",
    groupLink(groupId),
    "",
    "## Repositórios relacionados",
    relatedRepoIds.length
      ? relatedRepoIds.map((id) => `- ${repoLink(groupId, id)}`).join("\n")
      : "(nenhum repositório do grupo associado nesta versão)",
    "",
    `**Tipo de serviço:** ${meta.label}`,
    "",
    "## Integrações relacionadas",
    edgeList,
    "",
    "## Evidência (onde este recurso foi detectado no código)",
    evidenceList,
    "",
    AUTO_GENERATED_END,
  ].join("\n");
}

export function renderIntegrationNote(edge: GraphEdge, groupId: string, generatedAt: string): string {
  const isImpacted = edge.status !== "active";
  const hasVersionWarning = edge.status === "active" && Boolean(edge.versionWarning);
  const front = frontmatter({
    type: "integration",
    integrationType: edge.type,
    source: edge.source,
    target: edge.target,
    status: edge.status,
    group: groupId,
    confidence: edge.confidence,
    detectorId: edge.detectorId,
    version: edge.version ?? null,
    evidenceFile: edge.evidence.file,
    evidenceLine: edge.evidence.line ?? null,
    // "ok"/edge.status (broken/removed/impacted) / "warning" é o que o Graph View usa pra colorir —
    // o tipo da integração (edge.type) fica só como tag de filtro, sem cor própria (ver graphViewConfig.ts).
    tags: isImpacted
      ? ["integration", edge.type, edge.status, groupId]
      : hasVersionWarning
        ? ["integration", edge.type, "warning", groupId]
        : ["integration", edge.type, "ok", groupId],
  });

  const label = EDGE_LABELS[edge.type].label;
  const lineInfo = edge.evidence.line ? ` (linha ${edge.evidence.line})` : "";
  const impactHeading =
    edge.status === "broken"
      ? "## 🔴 Integração corrompida"
      : edge.status === "impacted"
        ? "## 🟠 Impactada em cascata"
        : hasVersionWarning
          ? edge.version === undefined
            ? "## 🟡 Contrato alterado — atenção"
            : "## 🟡 Versão alterada — atenção"
          : "";

  return [
    front,
    "",
    `# ${edge.source} → ${edge.target}`,
    "",
    AUTO_GENERATED_START,
    impactHeading ? `${impactHeading}\n${impactReason(edge)}` : "",
    edge.contractDiffDetails?.length
      ? edge.contractDiffDetails.map((line) => `- ${highlightDiffMarkdown(line)}`).join("\n")
      : "",
    `**Tipo:** ${label}`,
    edge.version ? `**Versão referenciada:** ${edge.version}` : "",
    "",
    "## Origem",
    nodeLink(groupId, edge.source),
    "",
    "## Destino",
    nodeLink(groupId, edge.target),
    "",
    "## Evidência",
    `Arquivo: \`${edge.evidence.file}\`${lineInfo}`,
    "```",
    edge.evidence.snippet,
    "```",
    "",
    `_Última confirmação: ${generatedAt}_`,
    AUTO_GENERATED_END,
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === "")) // evita linhas em branco duplicadas
    .join("\n");
}

function renderEdgeListItem(edge: GraphEdge, groupId: string): string {
  const marker =
    edge.status === "broken"
      ? " 🔴"
      : edge.status === "impacted"
        ? " 🟠 (impacto em cascata)"
        : edge.status === "removed"
          ? " 🗑️ (removida)"
          : edge.status === "active" && edge.versionWarning
            ? edge.version === undefined
              ? " 🟡 (schema mudou)"
              : " 🟡 (versão mudou)"
            : "";
  return `- ${integrationLink(groupId, edge.id)}${marker}`;
}

export function renderGroupNote(groupId: string, repoIds: string[], edges: GraphEdge[], ctx: GraphRenderContext): string {
  const front = frontmatter({
    type: "group",
    groupId,
    tags: ["group", groupId],
  });

  const repoList = repoIds.length ? repoIds.map((id) => `- ${repoLink(groupId, id)}`).join("\n") : "(nenhum repositório configurado)";

  // Repositórios no mesmo grupo/pasta nem sempre têm relação real entre si — sem separar por
  // componente conectado, dois (ou mais) times/aplicações sem NENHUMA integração cruzada acabam
  // desenhados juntos num único diagrama, como se fossem uma coisa só, só porque compartilham o
  // mesmo `.traceability/config.json`. Com mais de 1 componente, cada um vira seu próprio bloco
  // (diagrama + lista de integrações) claramente separado; com 1 só (o caso comum), o formato
  // continua idêntico ao de antes, sem seção extra.
  const serviceNodeIds = Array.from(ctx.serviceNodesById.keys());
  const components = findConnectedComponents(repoIds, serviceNodeIds, edges);
  const diagramIntro =
    "_Aresta: verde = saudável, amarelo = aviso (algo mudou, ex: versão da dependência — a integração continua ativa, o repositório dependente pode continuar funcionando normalmente com a versão anterior), laranja = impactada em cascata, vermelho = quebra direta (tracejado = removida, não detectada mais na última varredura). Nó (caixa = repositório, hexágono = serviço de infra — fila/tópico/Lambda/DNS/Step Function real mediando a integração): mesma lógica de cor (verde = OK, amarelo = aviso, laranja = atingido em cascata, vermelho = quebra direta); o tipo de cada um (linguagem do repo, ou tipo do serviço) aparece como texto entre parênteses no próprio nome._";

  const diagramSection =
    components.length <= 1
      ? [
          "## Diagrama de integrações",
          diagramIntro,
          "",
          renderMermaidGraph(repoIds, edges, ctx, { showTypeLabel: true, colorHealthyNodes: true }),
          "",
          "## Integrações conhecidas",
          edges.length ? edges.map((edge) => renderEdgeListItem(edge, groupId)).join("\n") : "(nenhuma integração detectada)",
        ]
      : [
          "## Diagrama de integrações",
          `_Este grupo tem **${components.length} aplicações sem nenhuma integração entre si** — cada uma abaixo é um componente conectado independente, detectado automaticamente (não configurado à mão)._`,
          diagramIntro,
          "",
          ...components.flatMap((component, index) => [
            `### Aplicação ${index + 1} — ${component.repoIds.length} repositório${component.repoIds.length === 1 ? "" : "s"}, ${component.edges.length} integraç${component.edges.length === 1 ? "ão" : "ões"}`,
            component.repoIds.map((id) => `- ${repoLink(groupId, id)}`).join("\n"),
            "",
            renderMermaidGraph(component.repoIds, component.edges, ctx, { showTypeLabel: true, colorHealthyNodes: true }),
            "",
            component.edges.length
              ? component.edges.map((edge) => renderEdgeListItem(edge, groupId)).join("\n")
              : "(nenhuma integração detectada)",
            "",
          ]),
        ];

  return [
    front,
    "",
    `# Grupo: ${groupId}`,
    "",
    "## Repositórios do grupo",
    repoList,
    "",
    ...diagramSection,
    "",
  ].join("\n");
}

function renderChangeEntry(diff: ImpactDiff, change: EdgeDiffEntry): string {
  const label = EDGE_LABELS[change.type].label;
  const otherRepo = change.source === diff.repoId ? change.target : change.source;
  const role = change.source === diff.repoId ? "origem" : "alvo";
  const lines = [
    `- **${integrationLink(diff.group, change.edgeId)}** (${label}, ${diff.repoId} como ${role})`,
    `  - Repo relacionado: ${nodeLink(diff.group, otherRepo)}`,
  ];
  if (change.status === "modified") {
    lines.push(`  - Versão: \`${change.previousVersion ?? "?"}\` → \`${change.currentVersion ?? "?"}\``);
  } else if (change.status === "added") {
    lines.push(`  - Versão detectada: \`${change.currentVersion ?? "?"}\``);
  } else if (change.status === "removed") {
    lines.push(`  - Última versão conhecida: \`${change.previousVersion ?? "?"}\``);
  }
  return lines.join("\n");
}

export function renderImpactReport(diff: ImpactDiff): string {
  const front = frontmatter({
    type: "impact-report",
    repo: diff.repoId,
    group: diff.group,
    generatedAt: diff.generatedAt,
    tags: ["impact-report", diff.group],
  });

  const added = diff.changes.filter((c) => c.status === "added");
  const modified = diff.changes.filter((c) => c.status === "modified");
  const removed = diff.changes.filter((c) => c.status === "removed");

  const sections: string[] = [front, "", `# Relatório de Impacto: ${diff.repoId}`, ""];

  if (added.length === 0 && modified.length === 0 && removed.length === 0) {
    sections.push("Nenhuma integração nova, removida ou modificada foi detectada para este repositório.", "");
  } else {
    if (added.length) sections.push("## Adicionadas", added.map((c) => renderChangeEntry(diff, c)).join("\n"), "");
    if (modified.length)
      sections.push("## Modificadas", modified.map((c) => renderChangeEntry(diff, c)).join("\n"), "");
    if (removed.length) sections.push("## Removidas", removed.map((c) => renderChangeEntry(diff, c)).join("\n"), "");
  }

  sections.push(
    "## Repos potencialmente impactados (blast radius)",
    diff.blastRadius.length
      ? diff.blastRadius.map((id) => `- ${nodeLink(diff.group, id)}`).join("\n")
      : "(nenhum outro repositório conectado)",
    "",
  );

  // Mudança de versão sem quebra não entra no blast radius (não há nenhuma edge broken/removed pra
  // cascatear a partir dela) — mas quem depende do repo que mudou pode querer revalidar mesmo assim,
  // já que uma versão nova pode alterar comportamento sem quebrar a assinatura da classe importada.
  const withDependents = (diff.versionChangeAwareness ?? []).filter((entry) => entry.dependentsToNotify.length > 0);
  if (withDependents.length > 0) {
    sections.push(
      "## Repositórios a avisar (mudança de versão sem quebra detectada)",
      "_Nenhum efeito colateral foi detectado hoje, mas a versão mudou — pode valer uma revalidação manual dos repositórios abaixo._",
      withDependents
        .map((entry) =>
          [
            `- **${integrationLink(diff.group, entry.edgeId)}** (\`${entry.previousVersion ?? "?"}\` → \`${entry.currentVersion ?? "?"}\`)`,
            ...entry.dependentsToNotify.map((id) => `  - ${nodeLink(diff.group, id)}`),
          ].join("\n"),
        )
        .join("\n"),
      "",
    );
  }

  return sections.join("\n");
}
