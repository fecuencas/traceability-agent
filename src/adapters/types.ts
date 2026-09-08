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

export interface RepoAnalysisResult {
  repoId: string;
  repoPath: string;
  language: Language;
  buildSystem: BuildSystem;
  coordinates: RepoCoordinates;
  scannedAt: string;
  commitSha?: string;
  signals: IntegrationSignal[];
}

export interface LanguageAdapter {
  id: string;
  /** Retorna true se este adapter sabe lidar com o repositório em repoPath. */
  matches(repoPath: string): boolean;
  analyze(repoPath: string, repoId: string): RepoAnalysisResult;
}
