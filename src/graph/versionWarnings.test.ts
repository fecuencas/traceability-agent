import assert from "node:assert/strict";
import { test } from "node:test";
import { flagVersionWarnings } from "./versionWarnings.js";
import type { GraphEdge, GraphSnapshot } from "./types.js";

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "source" | "target" | "type">): GraphEdge {
  return {
    confidence: "high",
    detectorId: "test",
    evidence: { file: "test.txt", snippet: "" },
    status: "active",
    ...overrides,
  };
}

function snapshot(edges: GraphEdge[]): GraphSnapshot {
  return { group: "g", generatedAt: "now", repos: [], edges, serviceNodes: [] };
}

test("sem baseline anterior (primeira varredura), nenhuma edge é marcada", () => {
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" })];
  const result = flagVersionWarnings(edges, undefined);
  assert.equal(result[0].versionWarning, undefined);
});

test("versão mudou numa edge active vira versionWarning: true", () => {
  const previous = snapshot([
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" }),
  ]);
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "2.0.0" })];
  const result = flagVersionWarnings(edges, previous);
  assert.equal(result[0].versionWarning, true);
});

test("versão igual à anterior não marca nada", () => {
  const previous = snapshot([
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" }),
  ]);
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" })];
  const result = flagVersionWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});

// Ortogonal a status: uma edge broken não deve virar "warning" mesmo que a versão também tenha
// mudado — quebra é sempre vermelho, nunca decai pra amarelo por causa de um versionWarning.
test("edge não-active não é marcada mesmo se a versão mudou", () => {
  const previous = snapshot([
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" }),
  ]);
  const edges = [
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "2.0.0", status: "broken" }),
  ];
  const result = flagVersionWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});

test("edge nova (sem correspondente na baseline anterior) não é marcada", () => {
  const previous = snapshot([]);
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", version: "1.0.0" })];
  const result = flagVersionWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});
