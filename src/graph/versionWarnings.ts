import type { GraphEdge, GraphSnapshot } from "./types.js";

/**
 * Marca `versionWarning: true` em toda edge `active` cuja versão mudou desde o snapshot salvo
 * anteriormente — não é uma quebra (o repo dependente pode continuar funcionando normalmente com a
 * versão antiga), é só um aviso de "algo mudou, vale revalidar manualmente". Puramente cosmético:
 * nunca altera `status`, nunca vira raiz de `applyCascadingImpact`. Sem snapshot anterior (primeira
 * varredura do grupo) não há nada pra comparar — todas as edges saem sem a marca.
 */
export function flagVersionWarnings(edges: GraphEdge[], previous: GraphSnapshot | undefined): GraphEdge[] {
  if (!previous) return edges;
  const previousById = new Map(previous.edges.map((edge) => [edge.id, edge]));

  return edges.map((edge) => {
    if (edge.status !== "active" || edge.version === undefined) return edge;
    const previousEdge = previousById.get(edge.id);
    if (!previousEdge || previousEdge.version === edge.version) return edge;
    return { ...edge, versionWarning: true };
  });
}
