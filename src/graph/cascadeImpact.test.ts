import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCascadingImpact } from "./cascadeImpact.js";
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

// Achado #2: uma dependência de artefato ATIVA cujo alvo já quebrou (como ORIGEM de uma edge de
// fluxo removida) precisa herdar o risco — sem isso, "billing-service" continuava verde mesmo
// dependendo de um "fulfillment-service" que parou de publicar.
test("cascata propaga para dependência cujo alvo quebrou como origem de fluxo (Achado #2)", () => {
  const edges = [
    edge({ id: "e1", source: "fulfillment-service", target: "svc_topic", type: "queue_publish", status: "removed" }),
    edge({ id: "e2", source: "billing-service", target: "fulfillment-service", type: "published_artifact_dependency" }),
  ];
  const result = applyCascadingImpact(edges, ["fulfillment-service", "billing-service"]);
  const e2 = result.find((e) => e.id === "e2");
  assert.equal(e2?.status, "impacted");
});

// Achado #6: uma dependência quebrada/removida NÃO deve promover o ALVO dela a origem própria de
// cascata — um cliente HTTP com endpoint desatualizado não prova que o alvo está quebrado, e não
// pode vazar pelas integrações saudáveis e não-relacionadas desse alvo.
test("cascata NÃO vaza do alvo de uma dependência quebrada pelas integrações saudáveis dele (Achado #6)", () => {
  const edges = [
    edge({ id: "e1", source: "customer-portal", target: "order-service", type: "outbound_http", status: "removed" }),
    edge({ id: "e2", source: "order-service", target: "svc_topic", type: "queue_publish" }),
  ];
  const result = applyCascadingImpact(edges, ["customer-portal", "order-service"]);
  const e2 = result.find((e) => e.id === "e2");
  assert.equal(e2?.status, "active");
});

test("cascata propaga a jusante a partir de uma edge de fluxo removida (caso base)", () => {
  const edges = [
    edge({ id: "e1", source: "order-service", target: "svc_topic", type: "queue_publish", status: "removed" }),
    edge({ id: "e2", source: "svc_topic", target: "fulfillment-service", type: "queue_consume" }),
  ];
  const result = applyCascadingImpact(edges, ["order-service", "fulfillment-service"]);
  const e2 = result.find((e) => e.id === "e2");
  assert.equal(e2?.status, "impacted");
});

test("sem nenhuma edge broken/removed, nada muda", () => {
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "outbound_http" })];
  const result = applyCascadingImpact(edges, ["a", "b"]);
  assert.deepEqual(result, edges);
});
