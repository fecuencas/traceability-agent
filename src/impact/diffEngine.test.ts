import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge, GraphSnapshot } from "../graph/types.js";
import { diffGraphs } from "./diffEngine.js";

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "source" | "target" | "type">): GraphEdge {
  return {
    confidence: "high",
    detectorId: "test",
    evidence: { file: "test.txt", snippet: "" },
    status: "active",
    ...overrides,
  };
}

function repo(repoId: string): RepoAnalysisResult {
  return {
    repoId,
    repoPath: `/tmp/${repoId}`,
    language: "node",
    buildSystem: "npm",
    coordinates: { packageName: repoId, version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
  };
}

function snapshot(edges: GraphEdge[], repoIds: string[]): GraphSnapshot {
  return { group: "test-group", generatedAt: new Date(0).toISOString(), repos: repoIds.map(repo), edges, serviceNodes: [] };
}

// Achado #3: quando uma edge de fluxo (fila) some, o blast radius precisa alcançar tanto quem
// está a JUSANTE dela (via o nó de serviço) quanto quem DEPENDE do repo que parou de publicar —
// a versão antiga (BFS não-direcionado só sobre edges atuais) nunca alcançava isso, porque a edge
// removida simplesmente não existe mais no snapshot atual, desconectando o subgrafo.
test("blastRadius alcança a jusante e quem depende do repo que quebrou (Achado #3)", () => {
  const previous = snapshot(
    [
      edge({ id: "e1", source: "fulfillment-service", target: "svc_topic", type: "queue_publish" }),
      edge({ id: "e2", source: "svc_topic", target: "analytics-service", type: "queue_consume" }),
      edge({ id: "e3", source: "billing-service", target: "fulfillment-service", type: "published_artifact_dependency" }),
    ],
    ["fulfillment-service", "analytics-service", "billing-service"],
  );
  // e1 sumiu (fulfillment-service parou de publicar); e2/e3 continuam ativas no scan atual.
  const current = snapshot(
    [
      edge({ id: "e2", source: "svc_topic", target: "analytics-service", type: "queue_consume" }),
      edge({ id: "e3", source: "billing-service", target: "fulfillment-service", type: "published_artifact_dependency" }),
    ],
    ["fulfillment-service", "analytics-service", "billing-service"],
  );

  const diff = diffGraphs("fulfillment-service", previous, current);

  assert.ok(diff.blastRadius.includes("analytics-service"), "deveria alcançar quem consome a jusante");
  assert.ok(diff.blastRadius.includes("billing-service"), "deveria alcançar quem depende do artefato de fulfillment-service");
  assert.ok(!diff.blastRadius.includes("fulfillment-service"), "o próprio repo alterado não deve aparecer no blast radius");
});

test("edge removida é classificada como 'removed' na lista de changes", () => {
  const previous = snapshot([edge({ id: "e1", source: "a", target: "b", type: "outbound_http" })], ["a", "b"]);
  const current = snapshot([], ["a", "b"]);
  const diff = diffGraphs("a", previous, current);
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].status, "removed");
});

// Feature "avisar sem quebrar": mudança de versão saudável não entra no blast radius, mas quem
// depende do repo que mudou de versão entra em versionChangeAwareness.
test("mudança de versão sem quebra vira versionChangeAwareness, não blastRadius", () => {
  const previous = snapshot(
    [
      edge({ id: "e1", source: "billing-service", target: "shared-utils", type: "published_artifact_dependency", version: "1.0.0" }),
      edge({ id: "e2", source: "payment-processor", target: "billing-service", type: "outbound_http" }),
    ],
    ["billing-service", "shared-utils", "payment-processor"],
  );
  const current = snapshot(
    [
      edge({ id: "e1", source: "billing-service", target: "shared-utils", type: "published_artifact_dependency", version: "1.1.0" }),
      edge({ id: "e2", source: "payment-processor", target: "billing-service", type: "outbound_http" }),
    ],
    ["billing-service", "shared-utils", "payment-processor"],
  );

  const diff = diffGraphs("billing-service", previous, current);

  assert.deepEqual(diff.blastRadius, []);
  assert.equal(diff.versionChangeAwareness.length, 1);
  assert.deepEqual(diff.versionChangeAwareness[0].dependentsToNotify, ["payment-processor"]);
});
