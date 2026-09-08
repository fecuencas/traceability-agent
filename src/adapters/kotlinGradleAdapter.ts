import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { lineNumberAt, scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "kotlin-gradle.http-client-scan",
    type: "outbound_http" as const,
    regex: /\bHttpClient\s*\{|\bOkHttpClient\b|\bRetrofit\b|\bWebClient\b/,
    confidence: "medium" as const,
  },
];

const QUEUE_TOPIC_RULES = [
  {
    detectorId: "kotlin-gradle.queue-publish-scan",
    type: "queue_publish" as const,
    regex: /(?:kafkaTemplate|rabbitTemplate)\s*\.\s*(?:send|convertAndSend)\(\s*"([^"]+)"/i,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "kotlin-gradle.queue-consume-scan",
    type: "queue_consume" as const,
    regex: /@(?:KafkaListener|RabbitListener)\(\s*(?:topics|queues)\s*=\s*\[?\s*"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "kotlin-gradle.sqs-consume-scan",
    type: "queue_consume" as const,
    regex: /@SqsListener\(\s*(?:value\s*=\s*)?\[?\s*"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
  {
    detectorId: "kotlin-gradle.sqs-publish-scan",
    type: "queue_publish" as const,
    regex: /sqsClient\s*\.\s*sendMessage\(\s*"([^"]+)"/i,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
];

/** Resolve `key = "literal"` ou `key = someVal` (buscando `val someVal = "literal"` no mesmo arquivo). */
function extractStringAssignment(content: string, key: string): string | undefined {
  const quotedMatch = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(content);
  if (quotedMatch) return quotedMatch[1];

  const identMatch = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*$`, "m").exec(content);
  if (identMatch) {
    const varName = identMatch[1];
    const valMatch = new RegExp(`val\\s+${varName}\\s*=\\s*"([^"]+)"`).exec(content);
    if (valMatch) return valMatch[1];
  }
  return undefined;
}

/**
 * Fallback quando build.gradle.kts não declara `artifactId` explicitamente (sem bloco de publishing,
 * comum em serviços internos que não publicam artefato) — o Gradle usa o nome do projeto como
 * identidade padrão, declarado em settings.gradle.kts via `rootProject.name = "..."`.
 */
function resolveArtifactIdFallback(repoPath: string): string | undefined {
  for (const fileName of ["settings.gradle.kts", "settings.gradle"]) {
    const filePath = path.join(repoPath, fileName);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const match = /rootProject\.name\s*=\s*"([^"]+)"/.exec(content);
    if (match) return match[1];
  }
  return path.basename(repoPath);
}

const DEPENDENCY_REGEX =
  /(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\(\s*["']([^:"']+):([^:"']+)(?::([^"']+))?["']\s*\)/g;

export const kotlinGradleAdapter: LanguageAdapter = {
  id: "kotlin-gradle",

  matches(repoPath: string): boolean {
    return (
      fs.existsSync(path.join(repoPath, "build.gradle.kts")) || fs.existsSync(path.join(repoPath, "build.gradle"))
    );
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const buildFilePath = fs.existsSync(path.join(repoPath, "build.gradle.kts"))
      ? path.join(repoPath, "build.gradle.kts")
      : path.join(repoPath, "build.gradle");
    const buildFileName = path.basename(buildFilePath);
    const rawText = fs.readFileSync(buildFilePath, "utf8");

    const ownGroup = extractStringAssignment(rawText, "group");
    const ownVersion = extractStringAssignment(rawText, "version") ?? "unknown";
    const ownArtifactId = extractStringAssignment(rawText, "artifactId") ?? resolveArtifactIdFallback(repoPath);

    const coordinates: RepoCoordinates = {
      groupId: ownGroup,
      artifactId: ownArtifactId,
      version: ownVersion,
    };

    const signals: IntegrationSignal[] = [];

    const regex = new RegExp(DEPENDENCY_REGEX.source, DEPENDENCY_REGEX.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawText)) !== null) {
      const [, groupId, artifactId, version] = match;
      const lineStart = rawText.lastIndexOf("\n", match.index) + 1;
      const lineEndIdx = rawText.indexOf("\n", match.index);
      const lineText = rawText.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx).trim();
      signals.push({
        type: "published_artifact_dependency",
        evidence: {
          file: buildFileName,
          line: lineNumberAt(rawText, match.index),
          snippet: lineText,
        },
        target: { kind: "repo_coordinate", value: `${groupId}:${artifactId}` },
        detectorId: "kotlin-gradle.dependency-scan",
        confidence: "high",
        version: version ?? "unknown",
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".kt"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".kt"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "kotlin-gradle.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "kotlin",
      buildSystem: "gradle",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
