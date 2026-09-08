import assert from "node:assert/strict";
import { test } from "node:test";
import { computeNodeSeverities, severityOf } from "./nodeSeverity.js";
import type { GraphEdge } from "./types.js";

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "source" | "target" | "type">): GraphEdge {
  return {
    confidence: "high",
    detectorId: "test",
    evidence: { file: "test.txt", snippet: "" },
    status: "active",
    ...overrides,
  };
}

test("edge active com versionWarning marca os 2 nós como warning", () => {
  const edges = [
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", versionWarning: true }),
  ];
  assert.equal(severityOf(edges, "a"), "warning");
  assert.equal(severityOf(edges, "b"), "warning");
});

test("warning nunca sobrepõe impacted/broken — rank broken > impacted > warning > ok", () => {
  const edges = [
    edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency", versionWarning: true }),
    edge({ id: "e2", source: "a", target: "c", type: "outbound_http", status: "broken" }),
  ];
  const severities = computeNodeSeverities(edges);
  assert.equal(severities.get("a"), "broken");
  assert.equal(severities.get("b"), "warning");
  assert.equal(severities.get("c"), "broken");
});

test("repo sem nenhuma edge tocando ele é ok", () => {
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "published_artifact_dependency" })];
  assert.equal(severityOf(edges, "z"), "ok");
});
