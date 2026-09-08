import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntegrationSignal, RepoAnalysisResult } from "../adapters/types.js";
import { buildGraph } from "./graphBuilder.js";

function makeRepo(repoId: string, signals: IntegrationSignal[]): RepoAnalysisResult {
  return {
    repoId,
    repoPath: `/tmp/${repoId}`,
    language: "node",
    buildSystem: "npm",
    coordinates: { packageName: repoId, version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals,
  };
}

// Achado #4: um publisher Kafka e um consumer SQS do MESMO tópico lógico (nome idêntico) precisam
// virar o MESMO ServiceNode — antes da correção, o id do nó incluía o serviceType (kafka vs
// aws-sqs), criando 2 nós diferentes pro mesmo tópico e deixando os dois repos desconectados.
test("publisher Kafka e consumer SQS do mesmo tópico compartilham um único ServiceNode", () => {
  const publisher = makeRepo("order-service", [
    {
      type: "queue_publish",
      evidence: { file: "OrderEventsPublisher.java", snippet: "" },
      target: { kind: "topic_name", value: "orders.created", serviceType: "kafka" },
      detectorId: "test",
      confidence: "high",
    },
  ]);
  const consumer = makeRepo("fulfillment-service", [
    {
      type: "queue_consume",
      evidence: { file: "OrderFulfillmentHandler.kt", snippet: "" },
      target: { kind: "topic_name", value: "orders.created", serviceType: "aws-sqs" },
      detectorId: "test",
      confidence: "high",
    },
  ]);

  const snapshot = buildGraph("test-group", [publisher, consumer]);

  assert.equal(snapshot.serviceNodes.length, 1);
  assert.equal(snapshot.edges.length, 2);
  const [publishEdge, consumeEdge] = snapshot.edges;
  assert.equal(publishEdge.target, consumeEdge.source, "os dois edges devem apontar pro mesmo nó de serviço");
});

test("dependência de artefato resolve edge entre 2 repos pela coordinate", () => {
  const producer = makeRepo("shared-utils", []);
  producer.coordinates = { groupId: "com.repotestes", artifactId: "shared-utils", version: "1.0.0" };
  const consumer = makeRepo("billing-service", [
    {
      type: "published_artifact_dependency",
      evidence: { file: "pom.xml", snippet: "" },
      target: { kind: "repo_coordinate", value: "com.repotestes:shared-utils" },
      detectorId: "test",
      confidence: "high",
      version: "1.0.0",
    },
  ]);

  const snapshot = buildGraph("test-group", [producer, consumer]);

  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.edges[0].source, "billing-service");
  assert.equal(snapshot.edges[0].target, "shared-utils");
  assert.equal(snapshot.edges[0].status, "active");
});
