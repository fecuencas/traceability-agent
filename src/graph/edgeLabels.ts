import type { IntegrationSignalType } from "../adapters/types.js";

export const EDGE_LABELS: Record<IntegrationSignalType, { slug: string; label: string }> = {
  published_artifact_dependency: { slug: "depends-on", label: "dependência de artefato publicado" },
  outbound_http: { slug: "calls-http", label: "chamada HTTP de saída" },
  queue_publish: { slug: "publishes-to", label: "publicação em fila" },
  queue_consume: { slug: "consumes-from", label: "consumo de fila" },
  contract_reference: { slug: "references-contract", label: "referência de contrato" },
  config_endpoint: { slug: "configured-endpoint", label: "endpoint configurado" },
  service_declaration: { slug: "owns", label: "posse de recurso de infraestrutura" },
};
