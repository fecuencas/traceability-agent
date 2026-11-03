import type { IntegrationSignalType } from "../adapters/types.js";

/** `emoji` diferencia o TIPO de integração a olho nu onde quer que o label apareça (rótulo da
 * aresta no diagrama Mermaid, chip de tipo no relatório HTML, listas de integração nas notas do
 * Obsidian) — mesmo papel que `LANGUAGE_META`/`SERVICE_TYPE_META` já cumprem pros NÓS (repo/serviço
 * de infra), mas para o eixo "que tipo de relação é essa" entre dois nós. Antes, chamada HTTP e
 * referência de contrato (os dois tipos mais comuns quando não há fila no meio) eram só uma linha
 * reta com texto, sem nenhum diferencial visual — só nós de serviço (fila/Lambda/...) tinham ícone
 * próprio, e aqueles só aparecem quando a integração passa por um recurso de infra real. */
export const EDGE_LABELS: Record<IntegrationSignalType, { slug: string; label: string; emoji: string }> = {
  published_artifact_dependency: { slug: "depends-on", label: "dependência de artefato publicado", emoji: "📦" },
  outbound_http: { slug: "calls-http", label: "chamada HTTP de saída", emoji: "🔌" },
  queue_publish: { slug: "publishes-to", label: "publicação em fila", emoji: "📤" },
  queue_consume: { slug: "consumes-from", label: "consumo de fila", emoji: "📥" },
  contract_reference: { slug: "references-contract", label: "referência de contrato", emoji: "📄" },
  config_endpoint: { slug: "configured-endpoint", label: "endpoint configurado", emoji: "⚙️" },
  service_declaration: { slug: "owns", label: "posse de recurso de infraestrutura", emoji: "🏷️" },
};
