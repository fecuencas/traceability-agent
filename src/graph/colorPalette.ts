import type { IntegrationSignalType } from "../adapters/types.js";
import type { GraphEdge } from "./types.js";

/**
 * Paleta hex por tipo de integração — usada só como metadado (chip/dot de "tipo" em tabelas e
 * legendas), NÃO mais para colorir a linha da aresta nos grafos. A linha da aresta segue o esquema
 * de 4 cores: verde saudável, amarelo aviso (algo mudou, sem quebra — ex: versão de dependência),
 * laranja impacto em cascata (estruturalmente íntegra, mas a jusante de uma quebra), vermelho
 * quebra direta/removida — ver `edgeColor`.
 */
export const TYPE_HEX_COLORS: Record<IntegrationSignalType, string> = {
  published_artifact_dependency: "#1e88e5",
  outbound_http: "#fb8c00",
  queue_publish: "#8e24aa",
  queue_consume: "#00897b",
  contract_reference: "#fdd835",
  config_endpoint: "#6d4c41",
  service_declaration: "#78909c",
};

export const ACTIVE_HEX_COLOR = "#2e7d32";
export const BROKEN_HEX_COLOR = "#e53935";
/** Cor de aresta/nó só atingido em cascata (estruturalmente íntegro, mas a jusante de uma quebra
 * real) — distinta tanto do vermelho de quebra direta quanto do amarelo de aviso. */
export const IMPACTED_HEX_COLOR = "#ef6c00";
/** Cor de "aviso, precisa de atenção" — algo mudou (ex: versão de uma dependência) mas a edge
 * continua `active`: o repo dependente PODE continuar funcionando normalmente com a versão
 * anterior, então não é quebra nem impacto em cascata, só um sinal pra revalidar manualmente. Ver
 * `GraphEdge.versionWarning`/`flagVersionWarnings`. */
export const WARNING_HEX_COLOR = "#f9a825";

/** Cor da LINHA da aresta no grafo: verde saudável, amarelo aviso, laranja impacto em cascata,
 * vermelho quebra direta/removida. */
export function edgeColor(edge: Pick<GraphEdge, "type" | "status" | "versionWarning">): string {
  if (edge.status === "active") return edge.versionWarning ? WARNING_HEX_COLOR : ACTIVE_HEX_COLOR;
  if (edge.status === "impacted") return IMPACTED_HEX_COLOR;
  return BROKEN_HEX_COLOR;
}
