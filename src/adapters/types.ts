export type Language = "java" | "kotlin" | "python" | "node" | "ruby" | "cpp" | "go" | "csharp" | "php" | "rust" | "unknown";
export type BuildSystem = "maven" | "gradle" | "npm" | "pip" | "bundler" | "cmake" | "go-modules" | "dotnet" | "composer" | "cargo" | "unknown";

export type IntegrationSignalType =
  | "outbound_http"
  | "published_artifact_dependency"
  | "queue_publish"
  | "queue_consume"
  | "contract_reference"
  | "config_endpoint"
  | "service_declaration";

export type TargetKind = "repo_coordinate" | "url" | "topic_name" | "contract_file" | "unresolved" | "service_resource";

export type Confidence = "high" | "medium" | "low";

/** Tipo de serviço de infraestrutura por trás de um sinal de fila/infra — usado para escolher o
 * ícone/nó de serviço certo no grafo (ex: distinguir uma fila SQS de um tópico Kafka, hoje
 * colapsados no mesmo `IntegrationSignalType`). */
export type ServiceType = "aws-lambda" | "aws-sqs" | "aws-route53" | "aws-step-functions" | "aws-ecs" | "kafka" | "contract";

export interface RepoCoordinates {
  groupId?: string;
  artifactId?: string;
  packageName?: string;
  version: string;
}

export interface SignalEvidence {
  file: string;
  line?: number;
  snippet: string;
}

export interface SignalTarget {
  kind: TargetKind;
  value: string;
  resolvedRepoId?: string;
  /** Provedor/tipo de serviço por trás do target (ex: "kafka" vs "aws-sqs" para um mesmo
   * `topic_name`, ou o tipo do recurso para um `service_resource`). Opcional: nem todo detector
   * sabe identificar o provedor. */
  serviceType?: ServiceType;
}

export interface IntegrationSignal {
  type: IntegrationSignalType;
  evidence: SignalEvidence;
  target: SignalTarget;
  detectorId: string;
  confidence: Confidence;
  /** Versão resolvida associada ao sinal (ex: versão do artefato dependido), quando aplicável.
   * Necessário para a Fase 3 (análise de impacto) detectar mudança de versão entre scans. */
  version?: string;
}

/** `error` = quebra a inicialização do framework com alta confiança (ex: classe principal do Spring
 * Boot sem `@SpringBootApplication` — o `ApplicationContext` nem sobe). `warning` = suspeito, mas
 * sem certeza total (ex: bean fora do pacote de component-scan — depende de como o scan foi
 * configurado em outro lugar do código, que o scanner nem sempre consegue resolver). */
export type LocalFindingSeverity = "error" | "warning";

/**
 * Achado de saúde estrutural de UM repositório, independente de integração com outros repos do
 * grupo (diferente de `IntegrationSignal`/`GraphEdge`, que são sempre sobre uma relação ENTRE
 * repositórios). Hoje só a checagem de wiring do Spring Boot usa isso (ver `src/springboot/`), mas
 * o tipo é genérico de propósito — `category` identifica o detector, não o framework.
 */
export interface LocalFinding {
  /** Estável dentro do repositório (mesma categoria + mesma evidência -> mesmo id), pra permitir
   * futuramente comparar entre scans (igual já se faz com edges) sem precisar disso agora. */
  id: string;
  severity: LocalFindingSeverity;
  category: string;
  message: string;
  evidence: SignalEvidence;
  /** true quando este achado específico significa que o repositório inteiro não sobe/não funciona
   * (ex: classe principal do Spring Boot sem `@SpringBootApplication` — o `ApplicationContext` nem
   * inicializa) — não apenas "um bean específico pode não existir". Usado pra alimentar a MESMA
   * cascata de impacto que uma integração quebrada já dispara (`applyCascadingImpact` em
   * `graph/cascadeImpact.ts`): quem depende deste repositório (chamada HTTP, artefato, contrato)
   * fica `impacted`, e o próprio repositório aparece como `broken` nos diagramas/notas — sem isso,
   * um serviço que nunca sobe apareceria "saudável" no grafo de integrações, só com um aviso de
   * texto isolado na própria nota. Ausente/false pros achados mais pontuais (ex: um `@Bean`
   * específico fora do ar, ou um bean fora do pacote de component-scan) — esses não têm confiança
   * suficiente de que DERRUBAM o serviço inteiro, então não cascateiam. */
  blocksStartup?: boolean;
}

export interface RepoAnalysisResult {
  repoId: string;
  repoPath: string;
  language: Language;
  buildSystem: BuildSystem;
  coordinates: RepoCoordinates;
  scannedAt: string;
  commitSha?: string;
  signals: IntegrationSignal[];
  /** Achados de saúde estrutural local (não-integração) — ver `LocalFinding`. Ausente/vazio quando
   * nenhum detector local se aplica a este repositório (ex: não usa Spring Boot). */
  localFindings?: LocalFinding[];
}

export interface LanguageAdapter {
  id: string;
  /** Retorna true se este adapter sabe lidar com o repositório em repoPath. */
  matches(repoPath: string): boolean;
  analyze(repoPath: string, repoId: string): RepoAnalysisResult;
}
