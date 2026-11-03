import type { GraphEdge } from "./types.js";

/**
 * Severidade de um repositório dentro do grafo: `broken` se ele participa diretamente de uma
 * integração corrompida ou removida (origem ou destino) OU se um `LocalFinding` seu com
 * `blocksStartup: true` diz que o repositório inteiro não sobe (ver `brokenRepoIds` abaixo);
 * `impacted` se só é alcançado em cascata (via `applyCascadingImpact`), sem estar diretamente numa
 * quebra; `warning` se não tem quebra nem impacto, mas participa de uma edge `active` com
 * `versionWarning` (ex: dependência com versão mudada, sem quebra detectada — repo pode continuar
 * funcionando com a versão anterior, só vale revalidar); `ok` caso contrário. Prioridade: `broken` >
 * `impacted` > `warning` > `ok`.
 */
export type NodeSeverity = "ok" | "warning" | "impacted" | "broken";

const SEVERITY_RANK: Record<NodeSeverity, number> = { ok: 0, warning: 1, impacted: 2, broken: 3 };

/**
 * `brokenRepoIds` — repositórios marcados `broken` independente de qualquer edge tocando eles (ex:
 * um achado local de Spring Boot com `blocksStartup: true`). Mesma lista que alimenta
 * `applyCascadingImpact` (`graph/cascadeImpact.ts`) como origem de cascata — aqui só garante que o
 * PRÓPRIO repositório também apareça vermelho, não só laranja por efeito colateral de uma de suas
 * edges virar `impacted`.
 */
export function computeNodeSeverities(edges: GraphEdge[], brokenRepoIds: Iterable<string> = []): Map<string, NodeSeverity> {
  const severities = new Map<string, NodeSeverity>();
  const bump = (repoId: string, level: NodeSeverity) => {
    const current = severities.get(repoId) ?? "ok";
    if (SEVERITY_RANK[level] > SEVERITY_RANK[current]) severities.set(repoId, level);
  };

  for (const edge of edges) {
    if (edge.status === "broken" || edge.status === "removed") {
      bump(edge.source, "broken");
      bump(edge.target, "broken");
    } else if (edge.status === "impacted") {
      bump(edge.source, "impacted");
      bump(edge.target, "impacted");
    } else if (edge.status === "active" && edge.versionWarning) {
      bump(edge.source, "warning");
      bump(edge.target, "warning");
    }
  }

  for (const repoId of brokenRepoIds) bump(repoId, "broken");

  return severities;
}

export function severityOf(edges: GraphEdge[], repoId: string, brokenRepoIds: Iterable<string> = []): NodeSeverity {
  return computeNodeSeverities(edges, brokenRepoIds).get(repoId) ?? "ok";
}
