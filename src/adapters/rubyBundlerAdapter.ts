import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "ruby-bundler.http-client-scan",
    type: "outbound_http" as const,
    regex: /HTTParty\s*\.\s*(?:get|post|put|delete)\(|RestClient\s*\.\s*(?:get|post|put|delete)\(|Net::HTTP\s*\.\s*(?:get|post|start)\(/,
    confidence: "medium" as const,
  },
];

/** Casa `gem "nome"` ou `gem "nome", "~> 1.2"` (com aspas simples ou duplas). */
const GEM_LINE = /^\s*gem\s+["']([\w-]+)["'](?:\s*,\s*["']([^"']+)["'])?/;

export const rubyBundlerAdapter: LanguageAdapter = {
  id: "ruby-bundler",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "Gemfile"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const gemfileContent = fs.readFileSync(path.join(repoPath, "Gemfile"), "utf8");

    const coordinates: RepoCoordinates = {
      packageName: repoId,
      version: "unknown",
    };

    const signals: IntegrationSignal[] = [];

    for (const rawLine of gemfileContent.split("\n")) {
      const trimmed = rawLine.trim();
      const match = GEM_LINE.exec(trimmed);
      if (!match) continue;
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "Gemfile", snippet: trimmed },
        target: { kind: "repo_coordinate", value: match[1] },
        detectorId: "ruby-bundler.dependency-scan",
        confidence: "high",
        version: match[2] ?? "unknown",
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".rb"], HTTP_CLIENT_RULES));
    signals.push(...scanContractFiles(repoPath, "ruby-bundler.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "ruby",
      buildSystem: "bundler",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
