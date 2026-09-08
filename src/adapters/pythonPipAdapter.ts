import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "python-pip.http-client-scan",
    type: "outbound_http" as const,
    regex: /\brequests\s*\.\s*(?:get|post|put|delete|patch)\(|httpx\s*\.\s*(?:get|post|put|delete|patch)\(/,
    confidence: "medium" as const,
  },
];

const QUEUE_TOPIC_RULES = [
  {
    detectorId: "python-pip.kafka-publish-scan",
    type: "queue_publish" as const,
    // confluent-kafka: `producer.produce("topic", ...)` — verbo específico dessa lib, não genérico
    // o suficiente pra colidir com outra coisa. kafka-python usa `producer.send(...)`, mas ".send("
    // é comum demais em código fora de Kafka (socket, sessão, sinal) pra virar regex sem contexto
    // cruzado entre linhas (o construtor `KafkaProducer(...)` pode estar longe da chamada `.send`)
    // — gap conhecido, documentado, não coberto (mesmo espírito do gap do `sarama` em Go).
    regex: /\.produce\(\s*["']([^"']+)["']/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "python-pip.kafka-consume-scan",
    type: "queue_consume" as const,
    // kafka-python: tópico como primeiro argumento posicional do construtor `KafkaConsumer(...)`.
    // confluent-kafka e kafka-python: `consumer.subscribe(["topic"])` (mesmo nome de método nas
    // duas libs) — ambos os construtos, coincidentemente, deixam o tópico bem perto do identificador
    // que denuncia Kafka, ao contrário do `.send`/`.produce` do lado publisher.
    regex: /(?:KafkaConsumer\(\s*|\.subscribe\(\s*\[\s*)["']([^"']+)["']/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
];

/** Casa `nome==1.2.3`, `nome>=1.2.3` ou `nome~=1.2.3` (formatos comuns de requirements.txt). */
const REQUIREMENT_LINE = /^([A-Za-z0-9_.-]+)\s*(==|>=|~=)\s*([A-Za-z0-9_.-]+)/;

export const pythonPipAdapter: LanguageAdapter = {
  id: "python-pip",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "requirements.txt"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const reqContent = fs.readFileSync(path.join(repoPath, "requirements.txt"), "utf8");

    const coordinates: RepoCoordinates = {
      packageName: repoId,
      version: "unknown",
    };

    const signals: IntegrationSignal[] = [];

    for (const rawLine of reqContent.split("\n")) {
      const trimmed = rawLine.trim();
      const match = REQUIREMENT_LINE.exec(trimmed);
      if (!match) continue;
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "requirements.txt", snippet: trimmed },
        target: { kind: "repo_coordinate", value: match[1] },
        detectorId: "python-pip.dependency-scan",
        confidence: "high",
        version: match[3],
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".py"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".py"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "python-pip.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "python",
      buildSystem: "pip",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
