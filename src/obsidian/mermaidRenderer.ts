import type { Language, RepoAnalysisResult, ServiceType } from "../adapters/types.js";
import { ACTIVE_HEX_COLOR, BROKEN_HEX_COLOR, IMPACTED_HEX_COLOR, WARNING_HEX_COLOR, edgeColor } from "../graph/colorPalette.js";
import { EDGE_LABELS } from "../graph/edgeLabels.js";
import { LANGUAGE_META } from "../graph/languageMeta.js";
import { computeNodeSeverities } from "../graph/nodeSeverity.js";
import { SERVICE_TYPE_META } from "../graph/serviceTypeMeta.js";
import type { GraphEdge, ServiceNode } from "../graph/types.js";

const EXTERNAL_NODE_LIMIT = 5;
const EXTERNAL_EDGE_COLOR = "#9aa5a6";

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Escapa texto antes de colocá-lo dentro de um label Mermaid entre aspas duplas (`"..."`). Sem
 * isso, um valor com aspas — vindo de conteúdo escaneado num repositório e portanto não confiável
 * (nome de tópico/fila extraído do código-fonte, versão de dependência, coordenada de artefato) —
 * fecha a string do label e permite injetar sintaxe Mermaid arbitrária (nós/arestas falsos,
 * `classDef`, `click`) no diagrama gerado. Os labels do Mermaid usam `htmlLabels` por padrão, então
 * entidades HTML decodificam de volta pro caractere literal sem reabrir marcação. */
export function escapeMermaidLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ");
}

/** Contexto compartilhado pelos três renderers para saber, a partir de um id de nó vizinho
 * encontrado numa aresta, se é um repositório (e qual linguagem) ou um nó de serviço de infra (e
 * qual tipo) — sem isso cada renderer teria que receber e cruzar as duas listas na mão. */
export interface GraphRenderContext {
  languageByRepoId: Map<string, Language>;
  serviceNodesById: Map<string, ServiceNode>;
}

export function buildRenderContext(repos: RepoAnalysisResult[], serviceNodes: ServiceNode[]): GraphRenderContext {
  return {
    languageByRepoId: new Map(repos.map((repo) => [repo.repoId, repo.language])),
    serviceNodesById: new Map(serviceNodes.map((node) => [node.id, node])),
  };
}

/** Opções de rotulagem de nó compartilhadas pelos três renderers Mermaid. */
interface NodeLabelOptions {
  /** Acrescenta `<br/>(tipo)` embaixo do nome — linguagem pro repositório, tipo de serviço (sem o
   * prefixo "aws-") pro nó de serviço — no lugar do ícone/cor por tipo. */
  showTypeLabel?: boolean;
}

/** "aws-lambda" -> "lambda", "aws-step-functions" -> "step-functions", "kafka" -> "kafka" (sem prefixo pra remover). */
function shortServiceTypeLabel(serviceType: ServiceType): string {
  return serviceType.replace(/^aws-/, "");
}

function repoNodeLabel(repoId: string, ctx: GraphRenderContext, options: NodeLabelOptions = {}): string {
  const language = ctx.languageByRepoId.get(repoId);
  const safeRepoId = escapeMermaidLabel(repoId);
  if (options.showTypeLabel) return language ? `${safeRepoId}<br/>(${language})` : safeRepoId;
  return language ? `${LANGUAGE_META[language].emoji} ${safeRepoId}` : safeRepoId;
}

/** Nome de `classDef` Mermaid válido (sem hífen) por tipo de serviço, ex: "aws-step-functions" -> "svcAwsStepFunctions". */
function svcClassName(serviceType: ServiceType): string {
  return "svc" + serviceType.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function serviceTypeClassDefs(): string[] {
  return (Object.keys(SERVICE_TYPE_META) as ServiceType[]).map((type) => {
    const color = SERVICE_TYPE_META[type].hexColor;
    return `    classDef ${svcClassName(type)} fill:${color},stroke:${color},color:#ffffff`;
  });
}

/** Declara a linha do nó certo para um id de vizinho: repositório vira caixa retangular, nó de
 * serviço de infra vira hexágono. Com `showTypeLabel`, o texto do tipo substitui o ícone/cor por
 * tipo (não aplica a classe `classDef` de cor); sem essa opção, comportamento igual a sempre. */
function declareNodeLines(id: string, ctx: GraphRenderContext, options: NodeLabelOptions = {}): { declLine: string; classLines: string[] } {
  const serviceNode = ctx.serviceNodesById.get(id);
  if (serviceNode) {
    const safeLabel = escapeMermaidLabel(serviceNode.label);
    if (options.showTypeLabel) {
      return {
        declLine: `    ${sanitizeId(id)}{{"${safeLabel}<br/>(${shortServiceTypeLabel(serviceNode.serviceType)})"}}`,
        classLines: [],
      };
    }
    const emoji = `${SERVICE_TYPE_META[serviceNode.serviceType].emoji} `;
    return {
      declLine: `    ${sanitizeId(id)}{{"${emoji}${safeLabel}"}}`,
      classLines: [`    class ${sanitizeId(id)} ${svcClassName(serviceNode.serviceType)}`],
    };
  }
  return { declLine: `    ${sanitizeId(id)}["${repoNodeLabel(id, ctx, options)}"]`, classLines: [] };
}

function edgeLabel(edge: GraphEdge): string {
  const versionSuffix = edge.version ? ` v${escapeMermaidLabel(edge.version)}` : "";
  const statusSuffix =
    edge.status === "broken"
      ? " ⚠️"
      : edge.status === "removed"
        ? " (removida)"
        : edge.status === "impacted"
          ? " (impacto em cascata)"
          : edge.versionWarning
            ? edge.version === undefined
              ? " (schema mudou)"
              : " (versão mudou)"
            : "";
  return `${EDGE_LABELS[edge.type].slug}${versionSuffix}${statusSuffix}`;
}

/** Estilo da linha no Mermaid: verde/vermelho por status, mais tracejado quando a integração sumiu da varredura. */
function edgeLinkStyle(edge: GraphEdge): string {
  const dash = edge.status === "removed" ? ",stroke-dasharray:5 3" : "";
  return `stroke:${edgeColor(edge)},stroke-width:2px${dash}`;
}

/** Ids (já no formato usado no diagrama), separados por severidade: vermelho = quebra direta,
 * laranja = só em cascata, amarelo = aviso (ex: versão mudou, sem quebra). */
function splitBySeverity(
  edges: GraphEdge[],
  toDiagramId: (repoId: string) => string,
): { brokenIds: Set<string>; impactedIds: Set<string>; warningIds: Set<string> } {
  const severities = computeNodeSeverities(edges);
  const brokenIds = new Set<string>();
  const impactedIds = new Set<string>();
  const warningIds = new Set<string>();
  for (const [repoId, severity] of severities) {
    if (severity === "broken") brokenIds.add(toDiagramId(repoId));
    else if (severity === "impacted") impactedIds.add(toDiagramId(repoId));
    else if (severity === "warning") warningIds.add(toDiagramId(repoId));
  }
  return { brokenIds, impactedIds, warningIds };
}

/**
 * Linhas Mermaid que pintam o NÓ (não só a aresta) do repositório conforme a severidade: vermelho
 * quando ele participa diretamente de uma quebra, laranja quando só é alcançado em cascata, amarelo
 * quando só tem um aviso (ex: dependência com versão mudada, sem quebra) — é o próprio nó que deve
 * alertar visualmente, não só a linha que liga a ele. Aplicada DEPOIS das classes de tipo de serviço
 * para que uma quebra futura nesse nó ainda vença visualmente.
 */
function severityStylingLines(brokenIds: Set<string>, impactedIds: Set<string>, warningIds: Set<string>): string[] {
  if (brokenIds.size === 0 && impactedIds.size === 0 && warningIds.size === 0) return [];
  const lines: string[] = [
    `    classDef brokenNode fill:${BROKEN_HEX_COLOR},stroke:#b71c1c,stroke-width:2px,color:#ffffff`,
    `    classDef impactedNode fill:${IMPACTED_HEX_COLOR},stroke:#a34e00,stroke-width:2px,color:#ffffff`,
    `    classDef warningNode fill:${WARNING_HEX_COLOR},stroke:#c17900,stroke-width:2px,color:#1a1a1a`,
  ];
  if (brokenIds.size) lines.push(`    class ${Array.from(brokenIds).join(",")} brokenNode`);
  if (impactedIds.size) lines.push(`    class ${Array.from(impactedIds).join(",")} impactedNode`);
  if (warningIds.size) lines.push(`    class ${Array.from(warningIds).join(",")} warningNode`);
  return lines;
}

/**
 * Gera um diagrama Mermaid (flowchart) com a cor de cada ARESTA controlada individualmente via
 * `linkStyle` — o Graph View nativo do Obsidian só permite colorir nós (é renderizado em canvas),
 * então este diagrama é o jeito de ter a cor real da linha por tipo/status da integração. Nós de
 * serviço de infra (filas, Lambda, DNS, Step Functions) que aparecem como origem/destino de alguma
 * aresta são declarados automaticamente como hexágonos, junto dos repositórios.
 */
export interface MermaidGraphOptions extends NodeLabelOptions {
  /** Colore de verde todo nó (repo ou serviço) que não está `broken`/`impacted` — fecha o esquema
   * de farol (verde/amarelo/vermelho) em vez de deixar o estado saudável sem nenhuma cor. Usado só
   * pelo relatório HTML por enquanto; as notas do Obsidian continuam sem essa cor de base. */
  colorHealthyNodes?: boolean;
}

export function renderMermaidGraph(
  repoIds: string[],
  edges: GraphEdge[],
  ctx: GraphRenderContext,
  options: MermaidGraphOptions = {},
): string {
  const lines: string[] = ["```mermaid", "flowchart LR"];
  const classLines: string[] = [];

  for (const repoId of repoIds) {
    lines.push(`    ${sanitizeId(repoId)}["${repoNodeLabel(repoId, ctx, options)}"]`);
  }

  const declaredServiceIds = new Set<string>();
  for (const edge of edges) {
    for (const endpointId of [edge.source, edge.target]) {
      if (!ctx.serviceNodesById.has(endpointId) || declaredServiceIds.has(endpointId)) continue;
      declaredServiceIds.add(endpointId);
      const { declLine, classLines: cl } = declareNodeLines(endpointId, ctx, options);
      lines.push(declLine);
      classLines.push(...cl);
    }
  }

  const linkStyles: string[] = [];
  edges.forEach((edge, index) => {
    lines.push(`    ${sanitizeId(edge.source)} -->|"${edgeLabel(edge)}"| ${sanitizeId(edge.target)}`);
    linkStyles.push(`    linkStyle ${index} ${edgeLinkStyle(edge)}`);
  });

  const { brokenIds, impactedIds, warningIds } = splitBySeverity(edges, sanitizeId);

  const healthyClassLines: string[] = [];
  if (options.colorHealthyNodes) {
    const allDiagramIds = new Set<string>([...repoIds.map(sanitizeId), ...Array.from(declaredServiceIds, sanitizeId)]);
    const healthyIds = Array.from(allDiagramIds).filter((id) => !brokenIds.has(id) && !impactedIds.has(id) && !warningIds.has(id));
    if (healthyIds.length) {
      healthyClassLines.push(
        `    classDef healthyNode fill:${ACTIVE_HEX_COLOR},stroke:#1b5e20,stroke-width:2px,color:#ffffff`,
        `    class ${healthyIds.join(",")} healthyNode`,
      );
    }
  }

  lines.push(
    ...linkStyles,
    ...(options.showTypeLabel ? [] : serviceTypeClassDefs()),
    ...classLines,
    ...healthyClassLines,
    ...severityStylingLines(brokenIds, impactedIds, warningIds),
    "```",
  );
  return lines.join("\n");
}

/**
 * Diagrama "micro" (ego-graph) de UM repositório: só ele e seus vizinhos diretos — quem depende
 * dele (entrada), de quem ele depende (saída, dentro do grupo rastreado, incluindo nós de serviço
 * de infra que mediam filas/recursos) e, de forma limitada, dependências de artefato não resolvidas
 * para nenhum outro repo rastreado (mostradas como nós tracejados, só para dar contexto de que existem).
 */
export function renderEgoGraph(
  repo: RepoAnalysisResult,
  outgoing: GraphEdge[],
  incoming: GraphEdge[],
  ctx: GraphRenderContext,
  options: MermaidGraphOptions = {},
): string {
  const selfId = sanitizeId(repo.repoId);
  const lines: string[] = ["```mermaid", "flowchart LR", `    ${selfId}["${repoNodeLabel(repo.repoId, ctx, options)}"]`];
  const declared = new Set([repo.repoId]);
  const classLines: string[] = [];
  const linkStyles: string[] = [];
  let edgeIndex = 0;

  const declareNeighbor = (id: string) => {
    if (declared.has(id)) return;
    declared.add(id);
    const { declLine, classLines: cl } = declareNodeLines(id, ctx, options);
    lines.push(declLine);
    classLines.push(...cl);
  };

  for (const edge of incoming) {
    declareNeighbor(edge.source);
    lines.push(`    ${sanitizeId(edge.source)} -->|"${edgeLabel(edge)}"| ${selfId}`);
    linkStyles.push(`    linkStyle ${edgeIndex} ${edgeLinkStyle(edge)}`);
    edgeIndex++;
  }

  for (const edge of outgoing) {
    declareNeighbor(edge.target);
    lines.push(`    ${selfId} -->|"${edgeLabel(edge)}"| ${sanitizeId(edge.target)}`);
    linkStyles.push(`    linkStyle ${edgeIndex} ${edgeLinkStyle(edge)}`);
    edgeIndex++;
  }

  // Dependência de artefato não resolvida já usa `target.value` (a coordenada em si, ex:
  // "org.junit.jupiter:junit-jupiter") como rótulo — identifica sozinho o que é. Chamada HTTP não
  // resolvida (`target.kind === "unresolved"`, ex: URL montada por variável/config em vez de string
  // literal na mesma linha) não tem esse luxo: `target.value` é só o texto do regex que casou (ex:
  // "fetch(", "RestTemplate"), igual pra toda chamada não resolvida do mesmo detector — usar isso
  // como rótulo faria várias chamadas diferentes colapsarem no mesmo nó "externo" sem distinção
  // nenhuma. Por isso usa `arquivo:linha` como rótulo pra chamada HTTP: sem isso, uma integração
  // real cuja URL não está inline (não detectável por design, análise é regex de 1 linha) ficava
  // 100% invisível no ego-graph — nem aparecia como "não resolvida", só sumia.
  const externalValues = Array.from(
    new Set([
      ...repo.signals
        .filter((signal) => signal.type === "published_artifact_dependency" && !signal.target.resolvedRepoId)
        .map((signal) => signal.target.value),
      ...repo.signals
        .filter((signal) => signal.type === "outbound_http" && signal.target.kind === "unresolved")
        .map((signal) => `HTTP não resolvido: ${signal.evidence.file}${signal.evidence.line ? `:${signal.evidence.line}` : ""}`),
    ]),
  );
  const shown = externalValues.slice(0, EXTERNAL_NODE_LIMIT);
  for (const value of shown) {
    const extId = `ext_${sanitizeId(value)}`;
    lines.push(`    ${extId}(("${escapeMermaidLabel(value)}"))`);
    lines.push(`    ${selfId} -.->|"externo"| ${extId}`);
    linkStyles.push(`    linkStyle ${edgeIndex} stroke:${EXTERNAL_EDGE_COLOR},stroke-width:1px,stroke-dasharray:3 3`);
    edgeIndex++;
  }
  if (externalValues.length > shown.length) {
    const moreId = `ext_more_${selfId}`;
    lines.push(`    ${moreId}(("+${externalValues.length - shown.length} externos"))`);
    lines.push(`    ${selfId} -.-> ${moreId}`);
    linkStyles.push(`    linkStyle ${edgeIndex} stroke:${EXTERNAL_EDGE_COLOR},stroke-width:1px,stroke-dasharray:3 3`);
    edgeIndex++;
  }

  const { brokenIds, impactedIds, warningIds } = splitBySeverity([...incoming, ...outgoing], sanitizeId);

  const healthyClassLines: string[] = [];
  if (options.colorHealthyNodes) {
    const healthyIds = Array.from(declared, sanitizeId).filter((id) => !brokenIds.has(id) && !impactedIds.has(id) && !warningIds.has(id));
    if (healthyIds.length) {
      healthyClassLines.push(
        `    classDef healthyNode fill:${ACTIVE_HEX_COLOR},stroke:#1b5e20,stroke-width:2px,color:#ffffff`,
        `    class ${healthyIds.join(",")} healthyNode`,
      );
    }
  }

  lines.push(
    ...linkStyles,
    ...(options.showTypeLabel ? [] : serviceTypeClassDefs()),
    ...classLines,
    ...healthyClassLines,
    ...severityStylingLines(brokenIds, impactedIds, warningIds),
    "```",
  );
  return lines.join("\n");
}

export interface OverviewGroup {
  groupId: string;
  /** Rótulo exibido no título da caixa (subgraph) — cai para `groupId` quando ausente. Usado
   * quando um mesmo grupo/config é desenhado como mais de uma caixa (componentes conectados sem
   * nenhuma integração entre si), pra distinguir "repo-testes — Aplicação 1" de "...— Aplicação 2". */
  label?: string;
  /** Chave usada para o id da caixa e o prefixo de namespacing dos nós — cai para `groupId` quando
   * ausente. Precisa ser única entre TODAS as caixas desenhadas juntas; obrigatório informar
   * quando o mesmo `groupId` aparece em mais de uma caixa (senão duas `subgraph` colidiriam no
   * mesmo id, que o Mermaid não aceita). */
  componentKey?: string;
  repos: Array<{ repoId: string; language: Language }>;
  serviceNodes: ServiceNode[];
  edges: GraphEdge[];
}

/**
 * Diagrama "macro": todas as aplicações (grupos) rastreadas num único mapa, cada uma numa caixa
 * (subgraph) nomeada com o grupo/repositório principal. Nós namespaced por grupo (`${grupo}__${id}`)
 * para não colidir entre aplicações diferentes — por isso não reaproveita `declareNodeLines`
 * (pensado para ids sem prefixo) e resolve linguagem/tipo de serviço localmente por grupo.
 */
export function renderOverviewGraph(groups: OverviewGroup[], options: MermaidGraphOptions = {}): string {
  const lines: string[] = ["```mermaid", "flowchart LR"];
  const linkStyles: string[] = [];
  const classLines: string[] = [];
  const allBrokenIds = new Set<string>();
  const allImpactedIds = new Set<string>();
  const allWarningIds = new Set<string>();
  const allDiagramIds = new Set<string>();
  const groupPrefixes: string[] = [];
  let edgeIndex = 0;

  for (const group of groups) {
    const prefix = sanitizeId(group.componentKey ?? group.groupId);
    groupPrefixes.push(prefix);
    const toDiagramId = (id: string) => `${prefix}__${sanitizeId(id)}`;
    lines.push(`    subgraph ${prefix}["${escapeMermaidLabel(group.label ?? group.groupId)}"]`);
    for (const repo of group.repos) {
      const safeRepoId = escapeMermaidLabel(repo.repoId);
      const label = options.showTypeLabel
        ? `${safeRepoId}<br/>(${repo.language})`
        : `${LANGUAGE_META[repo.language].emoji} ${safeRepoId}`;
      lines.push(`        ${toDiagramId(repo.repoId)}["${label}"]`);
      allDiagramIds.add(toDiagramId(repo.repoId));
    }
    for (const node of group.serviceNodes) {
      const safeLabel = escapeMermaidLabel(node.label);
      const label = options.showTypeLabel
        ? `${safeLabel}<br/>(${shortServiceTypeLabel(node.serviceType)})`
        : `${SERVICE_TYPE_META[node.serviceType].emoji} ${safeLabel}`;
      lines.push(`        ${toDiagramId(node.id)}{{"${label}"}}`);
      if (!options.showTypeLabel) classLines.push(`    class ${toDiagramId(node.id)} ${svcClassName(node.serviceType)}`);
      allDiagramIds.add(toDiagramId(node.id));
    }
    for (const edge of group.edges) {
      lines.push(`        ${toDiagramId(edge.source)} -->|"${edgeLabel(edge)}"| ${toDiagramId(edge.target)}`);
      linkStyles.push(`    linkStyle ${edgeIndex} ${edgeLinkStyle(edge)}`);
      edgeIndex++;
    }
    lines.push("    end");
    const { brokenIds, impactedIds, warningIds } = splitBySeverity(group.edges, toDiagramId);
    for (const id of brokenIds) allBrokenIds.add(id);
    for (const id of impactedIds) allImpactedIds.add(id);
    for (const id of warningIds) allWarningIds.add(id);
  }

  // Caixas sem NENHUMA aresta real entre si (aplicações desconectadas) não dão ao dagre (motor de
  // layout do Mermaid) nenhuma pista de ordem relativa — ele é livre pra arrumar as caixas na ordem
  // que quiser, o que já produziu a ordem visual invertida (5→1 em vez de 1→5) da declaração. Uma
  // aresta INVISÍVEL (`~~~`, sintaxe própria do Mermaid pra isso, sem linha nem seta) entre cada par
  // de caixas consecutivas força o dagre a respeitar a ordem de declaração sem alterar nada visível.
  for (let i = 0; i < groupPrefixes.length - 1; i++) {
    lines.push(`    ${groupPrefixes[i]} ~~~ ${groupPrefixes[i + 1]}`);
  }

  const healthyClassLines: string[] = [];
  if (options.colorHealthyNodes) {
    const healthyIds = Array.from(allDiagramIds).filter(
      (id) => !allBrokenIds.has(id) && !allImpactedIds.has(id) && !allWarningIds.has(id),
    );
    if (healthyIds.length) {
      healthyClassLines.push(
        `    classDef healthyNode fill:${ACTIVE_HEX_COLOR},stroke:#1b5e20,stroke-width:2px,color:#ffffff`,
        `    class ${healthyIds.join(",")} healthyNode`,
      );
    }
  }

  lines.push(
    ...linkStyles,
    ...(options.showTypeLabel ? [] : serviceTypeClassDefs()),
    ...classLines,
    ...healthyClassLines,
    ...severityStylingLines(allBrokenIds, allImpactedIds, allWarningIds),
    "```",
  );
  return lines.join("\n");
}
