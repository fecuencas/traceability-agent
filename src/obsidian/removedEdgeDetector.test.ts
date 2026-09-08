import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listRemovedEdges, reconstructMissingServiceNodes } from "./removedEdgeDetector.js";

// Desde o namespacing por grupo (Repos/Services/Integrations/<groupId>/<id>.md — evita colisão
// entre dois grupos independentes que reusem o mesmo id), as notas de cada grupo moram na SUA
// PRÓPRIA subpasta.
function makeVault(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  fs.mkdirSync(path.join(vaultPath, "Integrations", "repo-testes"), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, "Services", "repo-testes"), { recursive: true });
  return vaultPath;
}

test("listRemovedEdges reconstrói edges que não aparecem mais na varredura atual", () => {
  const vaultPath = makeVault();
  fs.writeFileSync(
    path.join(vaultPath, "Integrations", "repo-testes", "order-service__publishes-to__svc_topic_orders.created.md"),
    [
      "---",
      'type: "integration"',
      'integrationType: "queue_publish"',
      'source: "order-service"',
      'target: "svc_topic_orders.created"',
      'status: "active"',
      'group: "repo-testes"',
      'confidence: "high"',
      'detectorId: "java-maven.kafka-publish-scan"',
      'tags: ["integration","queue_publish","ok","repo-testes"]',
      "---",
      "",
      "# order-service -> svc_topic_orders.created",
    ].join("\n"),
    "utf8",
  );

  const removed = listRemovedEdges(vaultPath, "repo-testes", new Set());

  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, "order-service__publishes-to__svc_topic_orders.created");
  assert.equal(removed[0].status, "removed");
  assert.equal(removed[0].source, "order-service");

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("listRemovedEdges ignora integrações já detectadas na varredura atual", () => {
  const vaultPath = makeVault();
  const edgeId = "order-service__publishes-to__svc_topic_orders.created";
  fs.writeFileSync(
    path.join(vaultPath, "Integrations", "repo-testes", `${edgeId}.md`),
    ["---", 'group: "repo-testes"', 'source: "order-service"', 'target: "svc_topic_orders.created"', "---"].join("\n"),
    "utf8",
  );

  const removed = listRemovedEdges(vaultPath, "repo-testes", new Set([edgeId]));
  assert.equal(removed.length, 0);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("listRemovedEdges ignora um grupo que nem tem subpasta ainda (nunca escaneado)", () => {
  const vaultPath = makeVault();
  const removed = listRemovedEdges(vaultPath, "grupo-inexistente", new Set());
  assert.equal(removed.length, 0);
  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Segunda camada de defesa (a subpasta já separa por grupo estruturalmente): se uma nota com
// frontmatter de OUTRO grupo acabar dentro da subpasta errada (nota manual, tamperada, ou um
// resquício de uma versão anterior do agente sem o namespacing por pasta), ainda assim é ignorada.
test("listRemovedEdges ignora nota cujo frontmatter diz outro grupo, mesmo dentro da subpasta certa", () => {
  const vaultPath = makeVault();
  fs.writeFileSync(
    path.join(vaultPath, "Integrations", "repo-testes", "a__calls-http__b.md"),
    ["---", 'group: "outro-grupo"', 'source: "a"', 'target: "b"', "---"].join("\n"),
    "utf8",
  );

  const removed = listRemovedEdges(vaultPath, "repo-testes", new Set());
  assert.equal(removed.length, 0);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Achado #7: quando um recurso de infra some por completo da varredura (não só a edge), o
// ServiceNode em si precisa ser reconstruído a partir da nota antiga — senão os diagramas perdem o
// hexágono/rótulo amigável desse nó assim que uma edge removida ainda o referencia.
test("reconstructMissingServiceNodes reconstrói um ServiceNode a partir da nota de serviço antiga (Achado #7)", () => {
  const vaultPath = makeVault();
  fs.writeFileSync(
    path.join(vaultPath, "Services", "repo-testes", "svc_aws-ecs_payment-processor-svc.md"),
    [
      "---",
      'type: "service"',
      'serviceId: "svc_aws-ecs_payment-processor-svc"',
      'serviceType: "aws-ecs"',
      'label: "payment-processor-svc"',
      'group: "repo-testes"',
      'tags: ["service","repo-testes","aws-ecs","ok"]',
      "---",
    ].join("\n"),
    "utf8",
  );

  const reconstructed = reconstructMissingServiceNodes(vaultPath, "repo-testes", new Set());

  assert.equal(reconstructed.length, 1);
  assert.equal(reconstructed[0].id, "svc_aws-ecs_payment-processor-svc");
  assert.equal(reconstructed[0].serviceType, "aws-ecs");
  assert.equal(reconstructed[0].label, "payment-processor-svc");

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("reconstructMissingServiceNodes ignora serviços já presentes na varredura atual", () => {
  const vaultPath = makeVault();
  const serviceId = "svc_aws-ecs_payment-processor-svc";
  fs.writeFileSync(
    path.join(vaultPath, "Services", "repo-testes", `${serviceId}.md`),
    ["---", 'group: "repo-testes"', "---"].join("\n"),
    "utf8",
  );

  const reconstructed = reconstructMissingServiceNodes(vaultPath, "repo-testes", new Set([serviceId]));
  assert.equal(reconstructed.length, 0);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});
