import { diffContractFingerprints } from "./contractIntegrity.js";
import type { GraphEdge, GraphSnapshot } from "./types.js";

/**
 * Marca `versionWarning: true` (mesmo campo/cor que o aviso de versão de dependência — ver
 * `versionWarnings.ts`) em toda edge de contrato ISOLADO (sem sibling/consumidor mapeado, ver
 * `graphBuilder.ts`) cujo fingerprint de schema mudou desde a execução anterior. Reaproveita a
 * MESMA render-baseline de `flagVersionWarnings` (não precisa de outro arquivo de estado) — as duas
 * funções são chamadas em sequência nos mesmos 3 pontos (`updateObsidianGraph.ts`,
 * `generateHtmlReport.ts`, `overviewWriter.ts`).
 *
 * Por que sempre `warning`, nunca `broken`: sem nenhum outro repo do grupo referenciando o mesmo
 * arquivo, não há como confirmar que alguém realmente depende do campo que mudou — é o mesmo
 * raciocínio de `versionWarning` (o repositório dependente PODE continuar funcionando com a versão
 * antiga). Quando existe um sibling mapeado, a checagem é outra (`checkContractIntegrity`,
 * estrutural entre as duas cópias atuais) e vira `broken` de verdade — ver `graphBuilder.ts`.
 */
export function flagContractSchemaWarnings(edges: GraphEdge[], previous: GraphSnapshot | undefined): GraphEdge[] {
  if (!previous) return edges;
  const previousById = new Map(previous.edges.map((edge) => [edge.id, edge]));

  return edges.map((edge) => {
    if (edge.status !== "active" || !edge.contractSchemaFingerprint) return edge;
    const previousEdge = previousById.get(edge.id);
    if (!previousEdge?.contractSchemaFingerprint) return edge;
    const diffDetails = diffContractFingerprints(previousEdge.contractSchemaFingerprint, edge.contractSchemaFingerprint);
    if (diffDetails.length === 0) return edge;
    return { ...edge, versionWarning: true, contractDiffDetails: diffDetails };
  });
}
