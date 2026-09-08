import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { lineNumberAt, scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "java-maven.http-client-scan",
    type: "outbound_http" as const,
    regex: /\bRestTemplate\b|\bWebClient\b|\bRetrofit\b|\bOkHttpClient\b|@FeignClient|HttpClient\.newHttpClient/,
    confidence: "medium" as const,
  },
];

const QUEUE_TOPIC_RULES = [
  {
    detectorId: "java-maven.queue-publish-scan",
    type: "queue_publish" as const,
    regex: /(?:kafkaTemplate|rabbitTemplate)\s*\.\s*(?:send|convertAndSend)\(\s*"([^"]+)"/i,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "java-maven.queue-consume-scan",
    type: "queue_consume" as const,
    regex: /@(?:KafkaListener|RabbitListener)\(\s*(?:topics|queues)\s*=\s*"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "java-maven.sqs-consume-scan",
    type: "queue_consume" as const,
    regex: /@SqsListener\(\s*(?:value\s*=\s*)?"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
  {
    detectorId: "java-maven.sqs-publish-scan",
    type: "queue_publish" as const,
    regex: /sqsClient\s*\.\s*sendMessage\(\s*"([^"]+)"/i,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
];

interface MavenDependency {
  groupId?: string;
  artifactId?: string;
  version?: string | number;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveVersionPlaceholder(
  raw: string | undefined,
  properties: Record<string, unknown>,
  ownVersion: string,
): string {
  if (!raw) return "unknown";
  const match = /^\$\{(.+)\}$/.exec(raw.trim());
  if (!match) return raw;
  const key = match[1];
  if (key === "project.version") return ownVersion;
  const value = properties[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : raw;
}

function findDependencyEvidence(rawText: string, artifactId: string): { snippet: string; line: number } {
  const blockRegex = /<dependency>[\s\S]*?<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(rawText)) !== null) {
    if (match[0].includes(`<artifactId>${artifactId}</artifactId>`)) {
      return { snippet: match[0].trim(), line: lineNumberAt(rawText, match.index) };
    }
  }
  return { snippet: `<artifactId>${artifactId}</artifactId>`, line: 0 };
}

export const javaMavenAdapter: LanguageAdapter = {
  id: "java-maven",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "pom.xml"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const pomPath = path.join(repoPath, "pom.xml");
    const rawText = fs.readFileSync(pomPath, "utf8");
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(rawText);
    const project = parsed.project ?? {};
    const parent = project.parent ?? {};
    const properties: Record<string, unknown> = project.properties ?? {};

    const coordinates: RepoCoordinates = {
      groupId: project.groupId ?? parent.groupId,
      artifactId: project.artifactId,
      version: String(project.version ?? parent.version ?? "unknown"),
    };

    const signals: IntegrationSignal[] = [];

    const dependencies: MavenDependency[] = [
      ...toArray<MavenDependency>(project.dependencies?.dependency),
      ...toArray<MavenDependency>(project.dependencyManagement?.dependencies?.dependency),
    ];

    for (const dep of dependencies) {
      if (!dep?.groupId || !dep?.artifactId) continue;
      const version = resolveVersionPlaceholder(
        dep.version !== undefined ? String(dep.version) : undefined,
        properties,
        coordinates.version,
      );
      const evidence = findDependencyEvidence(rawText, dep.artifactId);
      signals.push({
        type: "published_artifact_dependency",
        evidence: {
          file: "pom.xml",
          line: evidence.line || undefined,
          snippet: evidence.snippet,
        },
        target: { kind: "repo_coordinate", value: `${dep.groupId}:${dep.artifactId}` },
        detectorId: "java-maven.dependency-scan",
        confidence: "high",
        version,
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".java"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".java"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "java-maven.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "java",
      buildSystem: "maven",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
