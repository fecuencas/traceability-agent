import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge, GraphSnapshot, ServiceNode } from "../graph/types.js";
import { renderHtmlReport } from "./htmlReport.js";

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

// Segurança (cenário de teste pedido pela auditoria externa, 2026-09): o relatório HTML mistura
// dados vindos do repositório escaneado — não confiável, já que o agente é feito pra rodar sobre
// código que o autor do relatório não controla — direto no markup. Entrada como
// `<script>alert('malicious')</script>` precisa terminar como TEXTO na página, nunca como uma tag
// executável de verdade.
test("nome de serviço malicioso com <script> aparece escapado no HTML, nunca como tag executável", () => {
  const payload = "<script>alert('malicious')</script>";
  const serviceNode: ServiceNode = {
    id: "svc:kafka:orders.created",
    serviceType: "kafka",
    label: payload,
    evidence: [{ file: "OrderPublisher.java", snippet: "" }],
  };
  const orderService = makeRepo({ repoId: "order-service", language: "java" });
  const shippingService = makeRepo({ repoId: "shipping-service", language: "python" });
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [orderService, shippingService],
    serviceNodes: [serviceNode],
    edges: [
      edge({ id: "e1", source: "order-service", target: serviceNode.id, type: "queue_publish" }),
      edge({ id: "e2", source: serviceNode.id, target: "shipping-service", type: "queue_consume" }),
    ],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(!html.includes(payload), "o payload cru nunca deveria sobreviver sem escape no HTML final");
  assert.ok(!/<script>alert/.test(html), "nenhuma tag <script> executável deveria aparecer no HTML final");
  // O label passa primeiro pelo escape de label Mermaid (`<` -> `&lt;`) e, como todo o diagrama
  // Mermaid é depois embutido dentro de um `<pre>` via escape de HTML, o `&` desse resultado é
  // escapado de novo (`&lt;` -> `&amp;lt;`) — mais seguro ainda que uma única passada, só não é o
  // MESMO texto escapado de um lugar que exibisse o label puro (ex: uma célula de tabela).
  assert.ok(/&(amp;)?lt;script&(amp;)?gt;/.test(html), "o payload deveria aparecer escapado como texto, não como tag viva");
});

// Mesmo cenário, mas no motivo de quebra de uma integração (`brokenReason`) — texto livre calculado
// a partir do conteúdo de contrato de dois repositórios, também não confiável.
test("brokenReason malicioso com <script> aparece escapado no card de problema do HTML", () => {
  const inventoryService = makeRepo({ repoId: "inventory-service", language: "kotlin" });
  const orderService = makeRepo({ repoId: "order-service", language: "java" });
  const payload = "<script>alert('malicious')</script>";
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [inventoryService, orderService],
    serviceNodes: [],
    edges: [
      edge({
        id: "e1",
        source: "inventory-service",
        target: "order-service",
        type: "contract_reference",
        status: "broken",
        brokenReason: payload,
      }),
    ],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(!html.includes(payload), "o payload cru nunca deveria sobreviver sem escape no HTML final");
  assert.ok(!/<script>alert/.test(html), "nenhuma tag <script> executável deveria aparecer no HTML final");
  assert.ok(html.includes("&lt;script&gt;"), "o payload deveria aparecer escapado como texto");
});
