import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalFinding, RepoAnalysisResult } from "../adapters/types.js";
import { applyCascadingImpact, brokenStartupRepoIds } from "./cascadeImpact.js";
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

// `brokenRepoIds` (2026-11): um repositório pode estar quebrado sem NENHUMA edge dizendo isso — ex:
// um LocalFinding de Spring Boot com `blocksStartup: true` (classe principal sem
// `@SpringBootApplication`, o ApplicationContext nunca sobe). Pedido real de usuário: "se o serviço
// não inicializa, isso devia gerar impacto onde?" — a resposta é: exatamente igual uma edge
// broken/removed propagaria, mesmo sem UMA edge sequer com status diferente de active.
test("brokenRepoIds propaga pra FRENTE via edge de fluxo (serviço que não sobe não publica nada)", () => {
  const edges = [edge({ id: "e1", source: "order-service", target: "svc_topic", type: "queue_publish" })];
  const result = applyCascadingImpact(edges, ["order-service"], ["order-service"]);
  const e1 = result.find((e) => e.id === "e1");
  assert.equal(e1?.status, "impacted");
});

test("brokenRepoIds propaga pra TRÁS via edge de dependência (quem chama o serviço que não sobe sofre)", () => {
  const edges = [edge({ id: "e1", source: "shipping-service", target: "order-service", type: "outbound_http" })];
  const result = applyCascadingImpact(edges, ["shipping-service", "order-service"], ["order-service"]);
  const e1 = result.find((e) => e.id === "e1");
  assert.equal(e1?.status, "impacted", "shipping-service depende de order-service, que não sobe — a chamada HTTP é impactada");
});

test("brokenRepoIds NÃO propaga pra FRENTE via edge de dependência (quem o serviço quebrado chama não sofre)", () => {
  const edges = [edge({ id: "e1", source: "order-service", target: "inventory-service", type: "outbound_http" })];
  const result = applyCascadingImpact(edges, ["order-service", "inventory-service"], ["order-service"]);
  const e1 = result.find((e) => e.id === "e1");
  assert.equal(
    e1?.status,
    "active",
    "order-service não subir não prova nada sobre a saúde de inventory-service — não pode vazar pelas integrações dele",
  );
});

test("brokenStartupRepoIds filtra só repos com um LocalFinding blocksStartup:true", () => {
  const brokenFinding: LocalFinding = {
    id: "f1",
    severity: "error",
    category: "spring-boot.missing-bootstrap-annotation",
    message: "x",
    evidence: { file: "x", snippet: "" },
    blocksStartup: true,
  };
  const nonBlockingFinding: LocalFinding = {
    id: "f2",
    severity: "error",
    category: "spring-boot.bean-method-without-configuration",
    message: "x",
    evidence: { file: "x", snippet: "" },
  };
  const repo = (id: string, findings: LocalFinding[]): RepoAnalysisResult => ({
    repoId: id,
    repoPath: "/tmp",
    language: "java",
    buildSystem: "maven",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
    localFindings: findings,
  });

  const result = brokenStartupRepoIds([repo("order-service", [brokenFinding]), repo("inventory-service", [nonBlockingFinding]), repo("shipping-service", [])]);

  assert.deepEqual(result, ["order-service"]);
});
