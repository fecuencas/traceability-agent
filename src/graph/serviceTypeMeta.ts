import type { ServiceType } from "../adapters/types.js";

/**
 * Metadados de exibição por tipo de serviço de infraestrutura (nó de serviço no grafo) — mesmo
 * padrão de `colorPalette.ts`/`edgeLabels.ts`, mas para o novo eixo "tipo de nó" em vez de "tipo de
 * aresta". `emoji` é usado como ícone nos diagramas Mermaid (funciona em qualquer instalação do
 * Obsidian, sem depender de plugin de ícones); `hexColor` colore o nó no HTML report e no `classDef`
 * Mermaid.
 */
export const SERVICE_TYPE_META: Record<ServiceType, { label: string; emoji: string; hexColor: string }> = {
  "aws-lambda": { label: "AWS Lambda", emoji: "⚡", hexColor: "#f58536" },
  "aws-sqs": { label: "Amazon SQS", emoji: "📬", hexColor: "#e05d44" },
  "aws-route53": { label: "Amazon Route 53 (DNS)", emoji: "🌐", hexColor: "#8c4fff" },
  "aws-step-functions": { label: "AWS Step Functions", emoji: "🔀", hexColor: "#cd2264" },
  "aws-ecs": { label: "Amazon ECS", emoji: "🐳", hexColor: "#ff9900" },
  kafka: { label: "Apache Kafka", emoji: "📨", hexColor: "#231f20" },
  contract: { label: "Contrato isolado (sem consumidor mapeado)", emoji: "📄", hexColor: "#6d4c41" },
};
