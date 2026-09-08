import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "node-npm.http-client-scan",
    type: "outbound_http" as const,
    regex: /\bfetch\(|axios\s*\.\s*(?:get|post|put|delete)\(|https?\.request\(/,
    confidence: "medium" as const,
  },
];

const QUEUE_TOPIC_RULES = [
  {
    detectorId: "node-npm.kafka-publish-scan",
    type: "queue_publish" as const,
    regex: /kafkaProducer\s*\.\s*send\(\s*["'`]([^"'`]+)["'`]/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "node-npm.kafka-consume-scan",
    type: "queue_consume" as const,
    regex: /kafkaConsumer\s*\.\s*subscribe\(\s*["'`]([^"'`]+)["'`]/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "node-npm.sqs-consume-scan",
    type: "queue_consume" as const,
    regex: /sqsConsumer\s*\.\s*subscribe\(\s*["'`]([^"'`]+)["'`]/,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
];

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export const nodeNpmAdapter: LanguageAdapter = {
  id: "node-npm",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "package.json"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const pkgPath = path.join(repoPath, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;

    const coordinates: RepoCoordinates = {
      packageName: pkg.name,
      version: pkg.version ?? "unknown",
    };

    const signals: IntegrationSignal[] = [];

    const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [depName, depVersion] of Object.entries(dependencies)) {
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "package.json", snippet: `"${depName}": "${depVersion}"` },
        target: { kind: "repo_coordinate", value: depName },
        detectorId: "node-npm.dependency-scan",
        confidence: "high",
        version: String(depVersion),
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".js", ".ts"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".js", ".ts"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "node-npm.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "node",
      buildSystem: "npm",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
