import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";
import { generateTestForEdge } from "./testGeneratorRegistry.js";

function repo(repoId: string, repoPath: string): RepoAnalysisResult {
  return {
    repoId,
    repoPath,
    language: "java",
    buildSystem: "maven",
    coordinates: { groupId: "com.example", artifactId: repoId, version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
  };
}

const edge: GraphEdge = {
  id: "billing-service__depends-on__shared-utils",
  source: "billing-service",
  target: "shared-utils",
  type: "published_artifact_dependency",
  confidence: "high",
  detectorId: "test",
  evidence: { file: "test.txt", snippet: "" },
  status: "active",
};

// Fase 6 (config descentralizado): gerar teste exige ESCREVER dentro de repoPath — se o repo foi
// resolvido via manifesto (sem checkout local nesta máquina), não pode silenciosamente criar uma
// pasta nova ali e gravar um teste sem sentido.
test("não gera teste quando o repoPath de origem não existe localmente", () => {
  const sourceRepo = repo("billing-service", "/caminho/que/nao/existe/nesta/maquina");
  const targetRepo = repo("shared-utils", "/tambem/nao/existe");

  const result = generateTestForEdge(sourceRepo, targetRepo, edge, [sourceRepo, targetRepo]);

  assert.equal(result, undefined);
});
