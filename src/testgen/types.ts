import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";

export interface GeneratedTest {
  edgeId: string;
  repoId: string;
  language: "java" | "kotlin";
  filePath: string;
  className: string;
  description: string;
}

export interface TestGenerator {
  id: string;
  language: "java" | "kotlin";
  /** Gera (e grava em disco) o teste de regressão para a integração `edge`, ou undefined se não aplicável. */
  generate(
    sourceRepo: RepoAnalysisResult,
    targetRepo: RepoAnalysisResult | undefined,
    edge: GraphEdge,
    allRepos: RepoAnalysisResult[],
  ): GeneratedTest | undefined;
}
