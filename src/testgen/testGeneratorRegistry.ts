import fs from "node:fs";
import { detectDominantSourceLanguage } from "../adapters/languageDetection.js";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";
import { javaTestGenerator } from "./javaTestGenerator.js";
import { kotlinTestGenerator } from "./kotlinTestGenerator.js";
import type { GeneratedTest } from "./types.js";

const GENERATORS = [javaTestGenerator, kotlinTestGenerator];

/**
 * Gera (e grava em disco) o teste de regressão para uma edge, escolhendo o gerador pela linguagem-fonte
 * REAL do repositório de origem (não pelo build system, que pode divergir — ex: Maven com fonte em Kotlin).
 */
export function generateTestForEdge(
  sourceRepo: RepoAnalysisResult,
  targetRepo: RepoAnalysisResult | undefined,
  edge: GraphEdge,
  allRepos: RepoAnalysisResult[] = [],
): GeneratedTest | undefined {
  // Um repo resolvido via manifesto (Fase 6) pode não ter checkout local nesta máquina — gerar
  // teste exige ESCREVER dentro de `repoPath`; sem essa guarda, `mkdirSync(..., {recursive:true})`
  // criaria silenciosamente uma pasta nova (não o repo de verdade) e gravaria um teste sem sentido lá.
  if (!fs.existsSync(sourceRepo.repoPath)) return undefined;

  const language = detectDominantSourceLanguage(sourceRepo.repoPath);
  const generator = GENERATORS.find((g) => g.language === language);
  return generator?.generate(sourceRepo, targetRepo, edge, allRepos);
}
