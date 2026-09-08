import { analyzeRepository } from "../adapters/adapterRegistry.js";
import type { RepoAnalysisResult } from "../adapters/types.js";
import { buildGraph } from "../graph/graphBuilder.js";
import type { GraphSnapshot } from "../graph/types.js";
import { discoverManifests, readManifest } from "./manifest.js";
import { loadGroupConfig, type GroupConfig, type GroupRepoConfig } from "./groupConfig.js";

export interface AnalyzedGroup {
  config: GroupConfig;
  repos: RepoAnalysisResult[];
  snapshot: GraphSnapshot;
}

/** Resolve um repo listado explicitamente em `repos[]`: via manifesto pré-gerado (sem re-escanear
 * agora) ou via re-scan ao vivo do `path` — nunca os dois, `manifestPath` tem prioridade quando
 * ambos estão presentes (o manifesto é o "estado publicado", mais barato de resolver). */
function resolveRepoAnalysis(repoConfig: GroupRepoConfig): RepoAnalysisResult {
  if (repoConfig.manifestPath) return readManifest(repoConfig.manifestPath).analysis;
  if (repoConfig.path) return analyzeRepository(repoConfig.path, repoConfig.id);
  throw new Error(`Repositório "${repoConfig.id}" precisa de "path" ou "manifestPath" em .traceability/config.json.`);
}

/**
 * Ponto único de "config -> repos escaneados -> grafo resolvido" — antes duplicado idêntico em 4
 * tools (`map_integrations`, `analyze_impact`, `update_obsidian_graph`, `generate_regression_tests`).
 * Suporta 3 formas de descrever um grupo, misturáveis: (a) tudo central (`path` por repo, como
 * sempre foi), (b) `{id, manifestPath, endpoints}` por repo — resolve do manifesto pré-gerado sem
 * re-escanear, endpoints continuam declarados aqui já que porta/host não dá pra inferir do código,
 * ou (c) `manifestsDir` no config — auto-descobre manifestos em cada subpasta imediata, zero
 * `repos[]` necessário. Repos explícitos em `repos[]` sempre vencem sobre a descoberta automática
 * quando o mesmo `repoId` aparece nos dois (só eles podem carregar `endpoints`).
 */
export function analyzeGroup(configPath?: string): AnalyzedGroup {
  const config = loadGroupConfig(configPath);

  const explicit = config.repos.map(resolveRepoAnalysis);
  const explicitIds = new Set(explicit.map((repo) => repo.repoId));

  const discovered = config.manifestsDir
    ? discoverManifests(config.manifestsDir)
        .map((manifest) => manifest.analysis)
        .filter((repo) => !explicitIds.has(repo.repoId))
    : [];

  const repos = [...explicit, ...discovered];
  const repoConfigs: GroupRepoConfig[] = [
    ...config.repos,
    ...discovered.map((repo) => ({ id: repo.repoId, coordinates: [], path: repo.repoPath })),
  ];
  const snapshot = buildGraph(config.groupId, repos, repoConfigs);
  return { config, repos, snapshot };
}
