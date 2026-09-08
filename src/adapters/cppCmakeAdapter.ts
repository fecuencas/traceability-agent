import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "cpp-cmake.http-client-scan",
    type: "outbound_http" as const,
    regex: /curl_easy_perform\(|cpr::(?:Get|Post|Put|Delete)\(/,
    confidence: "medium" as const,
  },
];

/** Casa `find_package(Nome ...)` (dependência de biblioteca externa declarada no CMake). */
const FIND_PACKAGE_LINE = /find_package\(\s*([\w-]+)/;

export const cppCmakeAdapter: LanguageAdapter = {
  id: "cpp-cmake",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "CMakeLists.txt"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const cmakeContent = fs.readFileSync(path.join(repoPath, "CMakeLists.txt"), "utf8");

    const coordinates: RepoCoordinates = {
      packageName: repoId,
      version: "unknown",
    };

    const signals: IntegrationSignal[] = [];

    for (const rawLine of cmakeContent.split("\n")) {
      const trimmed = rawLine.trim();
      const match = FIND_PACKAGE_LINE.exec(trimmed);
      if (!match) continue;
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "CMakeLists.txt", snippet: trimmed },
        target: { kind: "repo_coordinate", value: match[1] },
        detectorId: "cpp-cmake.dependency-scan",
        confidence: "high",
        version: "unknown",
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".cpp", ".cc", ".h", ".hpp"], HTTP_CLIENT_RULES));
    signals.push(...scanContractFiles(repoPath, "cpp-cmake.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "cpp",
      buildSystem: "cmake",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
