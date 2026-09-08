import assert from "node:assert/strict";
import { test } from "node:test";
import { flagContractSchemaWarnings } from "./contractSchemaWarnings.js";
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

test("sem baseline anterior, nenhuma edge é marcada", () => {
  const edges = [
    edge({
      id: "e1",
      source: "a",
      target: "svc_contract",
      type: "contract_reference",
      contractSchemaFingerprint: { "Order.id": "type=string;required=true" },
    }),
  ];
  const result = flagContractSchemaWarnings(edges, undefined);
  assert.equal(result[0].versionWarning, undefined);
});

test("fingerprint mudou desde a execução anterior: versionWarning true + contractDiffDetails preenchido", () => {
  const previous = snapshot([
    edge({
      id: "e1",
      source: "a",
      target: "svc_contract",
      type: "contract_reference",
      contractSchemaFingerprint: { "Order.customerName": "type=string;required=true;maxLength=120" },
    }),
  ]);
  const edges = [
    edge({
      id: "e1",
      source: "a",
      target: "svc_contract",
      type: "contract_reference",
      contractSchemaFingerprint: { "Order.customerName": "type=string;required=true;maxLength=60" },
    }),
  ];
  const result = flagContractSchemaWarnings(edges, previous);
  assert.equal(result[0].versionWarning, true);
  assert.equal(result[0].contractDiffDetails?.length, 1);
  assert.match(result[0].contractDiffDetails?.[0] ?? "", /Order\.customerName/);
});

test("fingerprint igual à anterior: não marca nada", () => {
  const fingerprint = { "Order.customerName": "type=string;required=true;maxLength=120" };
  const previous = snapshot([
    edge({ id: "e1", source: "a", target: "svc_contract", type: "contract_reference", contractSchemaFingerprint: fingerprint }),
  ]);
  const edges = [
    edge({ id: "e1", source: "a", target: "svc_contract", type: "contract_reference", contractSchemaFingerprint: { ...fingerprint } }),
  ];
  const result = flagContractSchemaWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});

// Este é exatamente o mecanismo que faz a transição "contrato isolado" -> "sibling apareceu" (ou
// vice-versa) não vazar um warning incorreto: sem fingerprint na edge (ex: já tem sibling mapeado,
// que usa checkContractIntegrity em vez disso), a função nem olha pra ela.
test("edge sem contractSchemaFingerprint (contrato com sibling mapeado) é ignorada", () => {
  const previous = snapshot([edge({ id: "e1", source: "a", target: "b", type: "contract_reference" })]);
  const edges = [edge({ id: "e1", source: "a", target: "b", type: "contract_reference" })];
  const result = flagContractSchemaWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});

test("edge broken não é marcada mesmo com fingerprint mudado", () => {
  const previous = snapshot([
    edge({
      id: "e1",
      source: "a",
      target: "svc_contract",
      type: "contract_reference",
      contractSchemaFingerprint: { "Order.id": "type=string;required=true" },
    }),
  ]);
  const edges = [
    edge({
      id: "e1",
      source: "a",
      target: "svc_contract",
      type: "contract_reference",
      status: "broken",
      contractSchemaFingerprint: { "Order.id": "type=number;required=true" },
    }),
  ];
  const result = flagContractSchemaWarnings(edges, previous);
  assert.equal(result[0].versionWarning, undefined);
});
