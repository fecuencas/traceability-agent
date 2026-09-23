import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge, ServiceNode } from "../graph/types.js";
import {
  buildRenderContext,
  escapeMermaidLabel,
  renderEgoGraph,
  renderMermaidGraph,
  renderOverviewGraph,
  type OverviewGroup,
} from "./mermaidRenderer.js";

function makeGroup(componentKey: string, label: string, repoId: string): OverviewGroup {
  return {
    groupId: "repo-testes",
    componentKey,
    label,
    repos: [{ repoId, language: "node" }],
    serviceNodes: [],
    edges: [],
  };
}

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

// Caixas (aplicações) sem NENHUMA aresta real entre si não dão ao dagre (motor de layout do
// Mermaid) nenhuma pista de ordem — ele é livre pra desenhar na ordem que quiser, o que já
// inverteu a exibição (5→1 em vez de 1→5) no Mapa geral do usuário. Uma aresta invisível (`~~~`)
// entre cada par de caixas consecutivas fixa a ordem sem desenhar nada visível.
test("renderOverviewGraph adiciona arestas invisíveis pra fixar a ordem de caixas desconectadas", () => {
  const groups = [
    makeGroup("app1", "Aplicação 1", "order-service"),
    makeGroup("app2", "Aplicação 2", "catalog-service"),
    makeGroup("app3", "Aplicação 3", "webhook-relay"),
  ];

  const diagram = renderOverviewGraph(groups);

  assert.ok(diagram.includes("app1 ~~~ app2"), "deveria fixar a ordem entre app1 e app2");
  assert.ok(diagram.includes("app2 ~~~ app3"), "deveria fixar a ordem entre app2 e app3");

  // A ordem de declaração dos subgraphs continua vindo primeiro que as arestas de ordenação.
  const subgraph1Index = diagram.indexOf("subgraph app1");
  const orderingLinkIndex = diagram.indexOf("app1 ~~~ app2");
  assert.ok(subgraph1Index < orderingLinkIndex);
});

test("com 1 componente só, não gera nenhuma aresta de ordenação", () => {
  const diagram = renderOverviewGraph([makeGroup("app1", "Aplicação 1", "order-service")]);
  assert.ok(!diagram.includes("~~~"));
});

// Segurança (achado da auditoria externa, 2026-09): nome de tópico/fila, versão de dependência e
// coordenada de artefato vêm do CÓDIGO-FONTE do repositório escaneado — conteúdo não confiável,
// já que o agente é feito pra rodar sobre repositórios que o autor do relatório não controla. Sem
// escapar aspas antes de colocar esse texto dentro de um label Mermaid entre aspas (`"..."`), um
// nome malicioso fecha a string do label e injeta sintaxe Mermaid arbitrária (nó/aresta falsos,
// `classDef`, `click`) no diagrama — não é execução de script (Mermaid roda em `securityLevel:
// strict` por padrão), mas é falsificação do próprio grafo de rastreabilidade, o que é justamente
// o que essa ferramenta existe pra impedir.
test("escapeMermaidLabel neutraliza aspas, colchetes e HTML sem quebrar a sintaxe do label", () => {
  const malicious = 'orders.created"]; classDef evil fill:#000; click x "javascript:alert(1)" _self; %%{init: {}}%%';
  const escaped = escapeMermaidLabel(malicious);

  assert.ok(!escaped.includes('"'), "nenhuma aspa literal deveria sobrar no texto escapado");
  assert.ok(escaped.includes("&quot;"), "aspa deveria virar entidade HTML");
});

test("nome de tópico malicioso não escapa do label do nó de serviço no diagrama macro/grafo geral", () => {
  const maliciousTopicName = 'orders.created"]] end classDef pwned fill:#ff0000 click pwned "javascript:alert(1)"';
  const serviceNode: ServiceNode = {
    id: "svc:kafka:orders.created",
    serviceType: "kafka",
    label: maliciousTopicName,
    evidence: [{ file: "OrderPublisher.java", snippet: "" }],
  };
  const orderService = makeRepo({ repoId: "order-service", language: "java" });
  const shippingService = makeRepo({ repoId: "shipping-service", language: "python" });
  const ctx = buildRenderContext([orderService, shippingService], [serviceNode]);
  const edges: GraphEdge[] = [
    edge({ id: "e1", source: "order-service", target: serviceNode.id, type: "queue_publish" }),
    edge({ id: "e2", source: serviceNode.id, target: "shipping-service", type: "queue_consume" }),
  ];

  const diagram = renderMermaidGraph(["order-service", "shipping-service"], edges, ctx);

  // O texto malicioso continua presente como conteúdo do label (não é removido, só neutralizado):
  // a aspa embutida nele nunca aparece como aspa literal, ou seja, nunca consegue fechar a string
  // do label Mermaid e "vazar" pra virar uma diretiva nova (classDef/click) fora dele.
  assert.ok(!diagram.includes(`"${maliciousTopicName}`), "o nome malicioso não deveria fechar a aspa do label");
  assert.ok(diagram.includes("&quot;"), "a aspa do payload deveria ter sido escapada como entidade");
});

test("versão de dependência maliciosa é escapada no label da aresta", () => {
  const inventoryService = makeRepo({ repoId: "inventory-service", language: "kotlin" });
  const orderService = makeRepo({ repoId: "order-service", language: "java" });
  const ctx = buildRenderContext([inventoryService, orderService], []);
  const maliciousVersion = '1.0.0"]; classDef pwned fill:#000';
  const edges: GraphEdge[] = [
    edge({
      id: "e1",
      source: "inventory-service",
      target: "order-service",
      type: "published_artifact_dependency",
      version: maliciousVersion,
    }),
  ];

  const diagram = renderMermaidGraph(["inventory-service", "order-service"], edges, ctx);

  assert.ok(!diagram.includes(`v${maliciousVersion}`), "a versão maliciosa não deveria aparecer sem escape");
});

test("coordenada de artefato maliciosa é escapada no ego-graph (nó externo não resolvido)", () => {
  const maliciousCoordinate = 'org.evil:payload"]] end classDef pwned fill:#000';
  const repo = makeRepo({
    repoId: "order-service",
    language: "java",
    signals: [
      {
        type: "published_artifact_dependency",
        confidence: "medium",
        detectorId: "test",
        evidence: { file: "pom.xml", snippet: "" },
        target: { kind: "repo_coordinate", value: maliciousCoordinate },
      },
    ],
  });
  const ctx = buildRenderContext([repo], []);

  const diagram = renderEgoGraph(repo, [], [], ctx);

  assert.ok(!diagram.includes(`"${maliciousCoordinate}`), "a coordenada maliciosa não deveria fechar a aspa do label");
});
