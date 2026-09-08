import type { LanguageAdapter, RepoAnalysisResult } from "./types.js";
import { cppCmakeAdapter } from "./cppCmakeAdapter.js";
import { csharpDotnetAdapter } from "./csharpDotnetAdapter.js";
import { goModulesAdapter } from "./goModulesAdapter.js";
import { javaMavenAdapter } from "./javaMavenAdapter.js";
import { kotlinGradleAdapter } from "./kotlinGradleAdapter.js";
import { nodeNpmAdapter } from "./nodeNpmAdapter.js";
import { phpComposerAdapter } from "./phpComposerAdapter.js";
import { pythonPipAdapter } from "./pythonPipAdapter.js";
import { rubyBundlerAdapter } from "./rubyBundlerAdapter.js";
import { rustCargoAdapter } from "./rustCargoAdapter.js";
import { scanInfraSignals } from "./iacDetector.js";

const ADAPTERS: LanguageAdapter[] = [
  javaMavenAdapter,
  kotlinGradleAdapter,
  nodeNpmAdapter,
  pythonPipAdapter,
  rubyBundlerAdapter,
  cppCmakeAdapter,
  goModulesAdapter,
  csharpDotnetAdapter,
  phpComposerAdapter,
  rustCargoAdapter,
];

export function findAdapter(repoPath: string): LanguageAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.matches(repoPath));
}

export function analyzeRepository(repoPath: string, repoId: string): RepoAnalysisResult {
  const adapter = findAdapter(repoPath);
  if (!adapter) {
    return {
      repoId,
      repoPath,
      language: "unknown",
      buildSystem: "unknown",
      coordinates: { version: "unknown" },
      scannedAt: new Date().toISOString(),
      signals: scanInfraSignals(repoPath),
    };
  }
  const result = adapter.analyze(repoPath, repoId);
  // Infra-as-code (Terraform/SAM/serverless.yml) é agnóstica de linguagem — roda para qualquer
  // repo, independente do adapter que o reconheceu, em vez de duplicar a chamada em cada um.
  result.signals.push(...scanInfraSignals(repoPath));
  return result;
}
