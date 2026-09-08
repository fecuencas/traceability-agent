import assert from "node:assert/strict";
import { test } from "node:test";
import { renderOverviewGraph, type OverviewGroup } from "./mermaidRenderer.js";

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
