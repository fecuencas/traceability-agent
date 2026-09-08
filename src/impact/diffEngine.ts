import type { IntegrationSignalType } from "../adapters/types.js";
import { applyCascadingImpact, isDependencyEdge } from "../graph/cascadeImpact.js";
import type { GraphEdge, GraphSnapshot } from "../graph/types.js";

export type EdgeChangeStatus = "unchanged" | "added" | "removed" | "modified";

export interface EdgeDiffEntry {
  status: EdgeChangeStatus;
  edgeId: string;
  source: string;
  target: string;
  type: IntegrationSignalType;
  previousVersion?: string;
  currentVersion?: string;
  edge?: GraphEdge;
}

/** Um repo que teve a versão de uma dependência alterada SEM quebrar nada (a integração continua
 * `active`), junto com quem depende dele e por isso pode querer ter ciência da mudança — mesmo sem
 * nenhum efeito colateral detectado hoje, uma revalidação manual pode ser prudente (ex: a nova
 * versão pode mudar comportamento sem quebrar a assinatura da classe importada). */
export interface VersionChangeAwareness {
  edgeId: string;
  source: string;
  target: string;
  previousVersion?: string;
  currentVersion?: string;
  dependentsToNotify: string[];
}

export interface ImpactDiff {
  group: string;
  repoId: string;
  generatedAt: string;
  changes: EdgeDiffEntry[];
  blastRadius: string[];
  versionChangeAwareness: VersionChangeAwareness[];
}

/** Reconstrói edges sintéticas (status "removed") para as integrações que sumiram do scan atual,
 * só com o essencial para alimentar `applyCascadingImpact` — mesma técnica usada pelo grafo/HTML
 * via `removedEdgeDetector`, aqui a partir do próprio diff (não precisa ler o vault). */
function reconstructRemovedEdges(changes: EdgeDiffEntry[]): GraphEdge[] {
  return changes
    .filter((change) => change.status === "removed")
    .map((change) => ({
      id: change.edgeId,
      source: change.source,
      target: change.target,
      type: change.type,
      version: change.previousVersion,
      confidence: "low",
      detectorId: "diff.reconstructed-removed",
      evidence: { file: "", snippet: "" },
      status: "removed",
    }));
}

/**
 * Blast radius = todos os repos que aparecem em uma edge `broken`/`removed`/`impacted` depois de
 * rodar a MESMA cascata direcionada usada no grafo/HTML (`applyCascadingImpact`), unificando os dois
 * mecanismos que antes divergiam (este usava BFS não-direcionado só sobre edges atuais, o que fazia
 * o relatório de impacto omitir repos realmente afetados a jusante de uma integração removida, e
 * listar repos não afetados só por estarem conectados de qualquer jeito no grafo).
 */
function computeBlastRadius(repoId: string, currentEdges: GraphEdge[], changes: EdgeDiffEntry[], repoIds: string[]): string[] {
  const edgesWithRemoved = [...currentEdges, ...reconstructRemovedEdges(changes)];
  const withCascade = applyCascadingImpact(edgesWithRemoved, repoIds);

  const affected = new Set<string>();
  for (const edge of withCascade) {
    if (edge.status === "broken" || edge.status === "removed" || edge.status === "impacted") {
      affected.add(edge.source);
      affected.add(edge.target);
    }
  }
  affected.delete(repoId);
  return Array.from(affected);
}

/**
 * A partir de `repoId`, caminha PARA TRÁS pelas edges de dependência (artefato/HTTP/contrato/config)
 * — quem declara depender de `repoId`, depois quem depende de quem depende dele, e assim por diante
 * — coletando todos os repositórios que podem querer saber que uma versão mudou em `repoId`, mesmo
 * sem nenhuma quebra detectada hoje. Diferente de `applyCascadingImpact`, não exige nenhuma edge
 * `broken`/`removed` como raiz: aqui o "evento" é a própria mudança de versão, não uma quebra.
 */
function findVersionChangeDependents(repoId: string, edges: GraphEdge[]): string[] {
  const incomingByTarget = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = incomingByTarget.get(edge.target) ?? [];
    list.push(edge);
    incomingByTarget.set(edge.target, list);
  }

  const visited = new Set<string>([repoId]);
  const queue: string[] = [repoId];
  const dependents: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of incomingByTarget.get(current) ?? []) {
      if (!isDependencyEdge(edge) || visited.has(edge.source)) continue;
      visited.add(edge.source);
      dependents.push(edge.source);
      queue.push(edge.source);
    }
  }
  return dependents;
}

/**
 * Para cada mudança de versão que NÃO quebrou nada (edge continua `active` — se tivesse quebrado,
 * já aparece via `blastRadius`/cor no grafo), lista quem depende do repo que mudou de versão, pra
 * dar ciência da mudança mesmo sem efeito colateral detectado — hoje o agente simplesmente não
 * avisa ninguém nesse caso, o que pode esconder uma regressão de comportamento (não de assinatura)
 * introduzida pela nova versão.
 */
function computeVersionChangeAwareness(changes: EdgeDiffEntry[], currentEdges: GraphEdge[]): VersionChangeAwareness[] {
  return changes
    .filter((change) => change.status === "modified" && change.edge?.status === "active")
    .map((change) => ({
      edgeId: change.edgeId,
      source: change.source,
      target: change.target,
      previousVersion: change.previousVersion,
      currentVersion: change.currentVersion,
      dependentsToNotify: findVersionChangeDependents(change.source, currentEdges),
    }));
}

/**
 * Compara o snapshot atual contra o anterior e retorna as mudanças de edges relevantes ao repo
 * alterado (upstream ou downstream), mais o blast radius calculado sobre o grafo atual completo.
 */
export function diffGraphs(repoId: string, previous: GraphSnapshot | undefined, current: GraphSnapshot): ImpactDiff {
  const previousEdges = new Map((previous?.edges ?? []).map((edge) => [edge.id, edge]));
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));

  const changes: EdgeDiffEntry[] = [];

  for (const [id, edge] of currentEdges) {
    const prevEdge = previousEdges.get(id);
    if (!prevEdge) {
      changes.push({
        status: "added",
        edgeId: id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        currentVersion: edge.version,
        edge,
      });
    } else if (prevEdge.version !== edge.version || prevEdge.evidence.snippet !== edge.evidence.snippet) {
      changes.push({
        status: "modified",
        edgeId: id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        previousVersion: prevEdge.version,
        currentVersion: edge.version,
        edge,
      });
    } else {
      changes.push({
        status: "unchanged",
        edgeId: id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        currentVersion: edge.version,
        edge,
      });
    }
  }

  for (const [id, prevEdge] of previousEdges) {
    if (!currentEdges.has(id)) {
      changes.push({
        status: "removed",
        edgeId: id,
        source: prevEdge.source,
        target: prevEdge.target,
        type: prevEdge.type,
        previousVersion: prevEdge.version,
      });
    }
  }

  const relevantChanges = changes.filter(
    (change) => change.status !== "unchanged" && (change.source === repoId || change.target === repoId),
  );

  return {
    group: current.group,
    repoId,
    generatedAt: current.generatedAt,
    changes: relevantChanges,
    blastRadius: computeBlastRadius(
      repoId,
      current.edges,
      changes,
      current.repos.map((repo) => repo.repoId),
    ),
    versionChangeAwareness: computeVersionChangeAwareness(relevantChanges, current.edges),
  };
}
