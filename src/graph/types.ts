import type { Confidence, IntegrationSignalType, RepoAnalysisResult, ServiceType, SignalEvidence } from "../adapters/types.js";

export type EdgeStatus = "active" | "broken" | "removed" | "impacted";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: IntegrationSignalType;
  version?: string;
  confidence: Confidence;
  detectorId: string;
  evidence: SignalEvidence;
  /** Resultado da checagem estática de integridade feita já na análise inicial (sem rodar build/testes). */
  status: EdgeStatus;
  brokenReason?: string;
  /** Detalhe estruturado de UMA quebra de contrato (`contract_reference`) — uma linha por operação
   * divergente, já formatada pra virar item de lista ("ausente em orders-api-provider: POST
   * /orders"). Só populado por `checkContractIntegrity`; usado nos lugares com espaço pra detalhar
   * (nota de integração, relatório HTML) — os lugares de resumo compacto (tabela, resumo de risco
   * da nota de repo/serviço) continuam usando só `brokenReason` (frase curta). */
  contractDiffDetails?: string[];
  /** Marca que a versão desta edge mudou desde o snapshot salvo anteriormente, mas ela continua
   * `active` — não é uma quebra (o repo dependente pode continuar funcionando com a versão
   * antiga), é um aviso de "algo mudou, vale checar". Ortogonal a `status`: nunca vira raiz de
   * cascata nem afeta `applyCascadingImpact` — só controla a cor amarela de "atenção" nos
   * diagramas/relatório, distinta do laranja de impacto em cascata. Calculado por
   * `flagVersionWarnings` a partir do snapshot anterior; ausente quando não há snapshot anterior
   * pra comparar (primeira varredura) ou quando não há sinal de mudança de versão. */
  versionWarning?: boolean;
  /** Fingerprint (uma string serializada por campo, ex: `"Order.customerName": "type=string;
   * required=true;maxLength=120"`) dos campos de `components.schemas` de um contrato ISOLADO — só
   * presente quando esta edge é a auto-declaração de um repo sobre seu próprio contrato, sem
   * nenhum sibling conhecido pra comparar estruturalmente (ver `graphBuilder.ts`). Persistido na
   * render-baseline e comparado pela execução seguinte em `flagContractSchemaWarnings`, do mesmo
   * jeito que `versionWarning` compara `version` — mas aqui a mudança sempre vira `warning`, nunca
   * `broken`, porque sem um consumidor mapeado não há como confirmar que alguém realmente depende
   * do campo que mudou. */
  contractSchemaFingerprint?: Record<string, string>;
}

/**
 * Nó de infraestrutura (fila, function, DNS, state machine) que fica NO MEIO de uma integração,
 * distinto de um repositório — ex: `order-service -> [Kafka: orders.created] -> fulfillment-service`
 * em vez de uma aresta repo-a-repo direta. `id` segue o formato `svc:<serviceType>:<nome>`, dedupado
 * entre repos (dois repos publicando no mesmo tópico apontam para o mesmo ServiceNode).
 */
export interface ServiceNode {
  id: string;
  serviceType: ServiceType;
  label: string;
  evidence: SignalEvidence[];
}

export interface GraphSnapshot {
  group: string;
  generatedAt: string;
  repos: RepoAnalysisResult[];
  edges: GraphEdge[];
  serviceNodes: ServiceNode[];
}
