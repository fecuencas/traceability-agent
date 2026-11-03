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

// brokenRepoIds (2026-11): um repositório com um LocalFinding `blocksStartup: true` (ex: Spring
// Boot sem @SpringBootApplication) precisa aparecer BROKEN (vermelho) mesmo sem nenhuma edge sua
// tendo esse status — as edges que tocam ele viram "impacted" pela cascata (ver cascadeImpact.ts),
// não "broken"; sem passar brokenRepoIds aqui também, o PRÓPRIO repo apareceria só impacted/laranja,
// como se o problema fosse de outra pessoa, não dele mesmo.
test("brokenRepoIds marca o repositório como broken mesmo com todas as edges dele active", () => {
  const edges = [edge({ id: "e1", source: "order-service", target: "svc_topic", type: "queue_publish" })];
  assert.equal(severityOf(edges, "order-service", ["order-service"]), "broken");
});

test("brokenRepoIds vence 'impacted' calculado a partir das edges (broken > impacted no rank)", () => {
  const edges = [edge({ id: "e1", source: "order-service", target: "svc_topic", type: "queue_publish", status: "impacted" })];
  const severities = computeNodeSeverities(edges, ["order-service"]);
  assert.equal(severities.get("order-service"), "broken");
});

test("brokenRepoIds não afeta repositório que não está na lista", () => {
  const edges = [edge({ id: "e1", source: "order-service", target: "shipping-service", type: "outbound_http" })];
  assert.equal(severityOf(edges, "shipping-service", ["order-service"]), "ok");
});
