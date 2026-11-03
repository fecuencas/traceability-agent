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

test("achado local (ex: Spring Boot) aparece na seção dedicada e conta no pill de problemas do topo", () => {
  const orderService = makeRepo({
    repoId: "order-service",
    language: "java",
    localFindings: [
      {
        id: "spring-boot.missing-bootstrap-annotation:x.java:7",
        severity: "error",
        category: "spring-boot.missing-bootstrap-annotation",
        message: "A classe X sobe o ApplicationContext mas não tem @SpringBootApplication.",
        evidence: { file: "src/main/java/X.java", line: 7, snippet: "SpringApplication.run(X.class, args);" },
      },
    ],
  });
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [orderService],
    serviceNodes: [],
    edges: [],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(html.includes("não tem @SpringBootApplication"), "a mensagem do achado deveria aparecer no relatório");
  assert.ok(html.includes("X.java:7"), "o arquivo:linha da evidência deveria aparecer no relatório");
  assert.ok(
    html.includes('<span class="pill pill-danger">1 problema encontrado</span>'),
    "um achado local 'error' deveria contar no pill de problemas do topo",
  );
  assert.ok(
    !html.includes('<span class="pill pill-success">'),
    "o pill do topo não pode afirmar que está tudo OK com um achado 'error' local presente " +
      "(a seção 'Problemas encontrados', que só lista ARESTAS quebradas, continua legitimamente vazia nesse cenário — é só o pill geral que não pode)",
  );
});

// Cenário real pedido por usuário: "se o Spring Boot não inicializa, isso gera impacto onde no
// diagrama?" — o nó do repositório com `blocksStartup: true` precisa ficar vermelho (brokenNode) no
// diagrama Mermaid embutido no relatório HTML, mesmo sem NENHUMA edge com status diferente de
// "active" no snapshot (o estilo visual do nó não depende de `applyCascadingImpact` já ter rodado
// sobre as edges — `renderHtmlReport` deriva `brokenRepoIds` direto de `repo.localFindings`).
test("repositório com LocalFinding blocksStartup:true aparece vermelho (brokenNode) no diagrama Mermaid, mesmo com todas as edges active", () => {
  const orderService = makeRepo({
    repoId: "order-service",
    language: "java",
    localFindings: [
      {
        id: "spring-boot.missing-bootstrap-annotation:x.java:7",
        severity: "error",
        category: "spring-boot.missing-bootstrap-annotation",
        message: "A classe X sobe o ApplicationContext mas não tem @SpringBootApplication.",
        evidence: { file: "src/main/java/X.java", line: 7, snippet: "SpringApplication.run(X.class, args);" },
        blocksStartup: true,
      },
    ],
  });
  const shippingService = makeRepo({ repoId: "shipping-service", language: "python" });
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [orderService, shippingService],
    serviceNodes: [],
    edges: [edge({ id: "e1", source: "shipping-service", target: "order-service", type: "outbound_http" })],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(html.includes("classDef brokenNode"), "o diagrama deveria declarar a classe de nó vermelho");
  assert.ok(/class [^\n]*order_service[^\n]* brokenNode/.test(html), "order-service deveria estar na lista de nós marcados brokenNode");
});

// Mesmo cenário de segurança das duas provas acima, mas pra mensagem de um LocalFinding — também é
// texto vindo de código escaneado (ex: nome de classe extraído do repositório), não confiável.
test("mensagem de achado local maliciosa com <script> aparece escapada no HTML, nunca como tag executável", () => {
  const payload = "<script>alert('malicious')</script>";
  const orderService = makeRepo({
    repoId: "order-service",
    language: "java",
    localFindings: [
      {
        id: "spring-boot.bean-outside-component-scan:x.java:3",
        severity: "warning",
        category: "spring-boot.bean-outside-component-scan",
        message: payload,
        evidence: { file: "src/main/java/X.java", line: 3, snippet: payload },
      },
    ],
  });
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [orderService],
    serviceNodes: [],
    edges: [],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(!html.includes(payload), "o payload cru nunca deveria sobreviver sem escape no HTML final");
  assert.ok(!/<script>alert/.test(html), "nenhuma tag <script> executável deveria aparecer no HTML final");
  assert.ok(html.includes("&lt;script&gt;"), "o payload deveria aparecer escapado como texto");
});

// Pedido real de usuário: diferenciar o tipo de integração a olho nu — o chip de tipo na tabela/
// cards de problema do relatório HTML também recebe o emoji do tipo, igual o rótulo da aresta no
// diagrama Mermaid.
test("chip de tipo de integração inclui o emoji do tipo (ex: 🔌 pra chamada HTTP)", () => {
  const orderService = makeRepo({ repoId: "order-service", language: "java" });
  const inventoryService = makeRepo({ repoId: "inventory-service", language: "kotlin" });
  const snapshot: GraphSnapshot = {
    group: "repos-testing",
    generatedAt: new Date(0).toISOString(),
    repos: [orderService, inventoryService],
    serviceNodes: [],
    edges: [edge({ id: "e1", source: "order-service", target: "inventory-service", type: "outbound_http" })],
  };

  const html = renderHtmlReport(snapshot);

  assert.ok(html.includes("🔌"), "o chip de tipo deveria trazer o emoji de chamada HTTP");
});
