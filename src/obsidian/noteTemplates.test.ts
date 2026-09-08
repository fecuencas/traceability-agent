import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";
import { buildRenderContext } from "./mermaidRenderer.js";
import { renderRepoNote } from "./noteTemplates.js";

function makeRepo(overrides: Partial<RepoAnalysisResult> & Pick<RepoAnalysisResult, "repoId" | "language">): RepoAnalysisResult {
  return {
    repoPath: "/tmp/repo",
    buildSystem: "npm",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
    ...overrides,
  };
}

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "source" | "target" | "type">): GraphEdge {
  return {
    confidence: "high",
    detectorId: "test",
    evidence: { file: "test.txt", snippet: "" },
    status: "active",
    ...overrides,
  };
}

// Achado (2026-09): o heading da nota de repo usava o emoji da LINGUAGEM (LANGUAGE_META), não da
// saúde do repo. Node.js usa 🟢 como emoji de linguagem — igual, em forma e cor, ao vocabulário de
// severidade (🟢 ok / 🟡 warning / 🟠 impacted / 🔴 broken) usado em todo o resto da nota. Um repo
// Node com uma integração quebrada mostrava "# 🟢 repoId" bem em cima de um resumo de risco
// vermelho e de um diagrama vermelho na mesma nota — parecia contradição visual, mesmo a
// tag/cor real (frontmatter, Mermaid) já estando corretas.
test("heading da nota reflete a severidade real, não o emoji da linguagem (Node.js = 🟢, colide com 'ok')", () => {
  const repo = makeRepo({ repoId: "orders-api-provider", language: "node" });
  const incoming = [
    edge({
      id: "orders-api-consumer__references-contract__orders-api-provider",
      source: "orders-api-consumer",
      target: "orders-api-provider",
      type: "contract_reference",
      status: "broken",
      brokenReason: "Contrato divergente.",
    }),
  ];
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], incoming, ctx);
  assert.match(note, /^# 🔴 orders-api-provider/m);
  assert.doesNotMatch(note, /^# 🟢 orders-api-provider/m);
});

test("heading mostra 🟢 quando o repo Node realmente está saudável", () => {
  const repo = makeRepo({ repoId: "healthy-node-service", language: "node" });
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], [], ctx);
  assert.match(note, /^# 🟢 healthy-node-service/m);
});
