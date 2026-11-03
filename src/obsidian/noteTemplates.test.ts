import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";
import { buildRenderContext } from "./mermaidRenderer.js";
import { renderRepoNote } from "./noteTemplates.js";

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

// Achado (2026-11, numa demonstração real): com mais de uma integração impactando o mesmo
// repositório, o resumo de risco mostrava "5 integraçãoões" — "integração" com "ões" simplesmente
// concatenado no final, em vez de trocar "ão" por "ões" (mesmo padrão de pluralização já usado
// corretamente em outro lugar da mesma nota, ex: "3 integrações").
test("resumo de risco pluraliza 'integrações' corretamente com mais de uma integração impactando o repo", () => {
  const repo = makeRepo({ repoId: "order-service", language: "java" });
  const incoming = [
    edge({ id: "e1", source: "shipping-service", target: "order-service", type: "outbound_http", status: "impacted" }),
    edge({ id: "e2", source: "inventory-service", target: "order-service", type: "contract_reference", status: "impacted" }),
  ];
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], incoming, ctx);

  assert.ok(note.includes("2 integrações impactando este repositório"));
  assert.ok(!note.includes("integraçãoões"));
});

// Achado (2026-09): o heading da nota de repo usava o emoji da LINGUAGEM (LANGUAGE_META), não da
// saúde do repo. Node.js usa 🟢 como emoji de linguagem — igual, em forma e cor, ao vocabulário de
// severidade (🟢 ok / 🟡 warning / 🟠 impacted / 🔴 broken) usado em todo o resto da nota. Um repo
// Node com uma integração quebrada mostrava "# 🟢 repoId" bem em cima de um resumo de risco
// vermelho e de um diagrama vermelho na mesma nota — parecia contradição visual, mesmo a
// tag/cor real (frontmatter, Mermaid) já estando corretas.
test("heading da nota reflete a severidade real, não o emoji da linguagem (Node.js = 🟢, colide com 'ok')", () => {
  const repo = makeRepo({ repoId: "orders-api-provider", language: "node" });
  const incoming = [
    edge({
      id: "orders-api-consumer__references-contract__orders-api-provider",
      source: "orders-api-consumer",
      target: "orders-api-provider",
      type: "contract_reference",
      status: "broken",
      brokenReason: "Contrato divergente.",
    }),
  ];
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], incoming, ctx);
  assert.match(note, /^# 🔴 orders-api-provider/m);
  assert.doesNotMatch(note, /^# 🟢 orders-api-provider/m);
});

test("heading mostra 🟢 quando o repo Node realmente está saudável", () => {
  const repo = makeRepo({ repoId: "healthy-node-service", language: "node" });
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], [], ctx);
  assert.match(note, /^# 🟢 healthy-node-service/m);
});

// Achado local (ex: Spring Boot) sempre aparece no corpo da nota e numa tag própria no frontmatter,
// independente de cascatear ou não. O efeito no HEADING/emoji de severidade depende inteiramente de
// `brokenRepoIds`: quem CHAMA `renderRepoNote` (`obsidianWriter.ts`) decide quais LocalFindings
// contam como "o repositório inteiro não sobe" (`blocksStartup: true`) e repassa a lista — sem
// receber essa lista (como aqui), a nota continua refletindo só o grafo de integrações, mesmo com
// um achado local `error` presente.
test("achado local 'error' aparece no corpo da nota e na tag do frontmatter; sem brokenRepoIds, o heading não muda", () => {
  const repo = makeRepo({
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
  const ctx = buildRenderContext([repo], []);

  const note = renderRepoNote(repo, "repo-testes", [], [], ctx);

  assert.match(note, /^# 🟢 order-service/m, "sem repassar brokenRepoIds, o heading continua refletindo só o grafo de integrações");
  assert.ok(note.includes("não tem @SpringBootApplication"));
  assert.ok(note.includes("src/main/java/X.java:7"));
  assert.ok(note.includes("has-local-finding-error"), "tag de frontmatter deveria marcar o achado local 'error'");
});

// Cenário real pedido por usuário: "se o Spring Boot não inicializa por um bug local, isso gera
// impacto onde?" — a resposta é via `brokenRepoIds` (derivado de `blocksStartup: true` pelo
// chamador, ver `cascadeImpact.brokenStartupRepoIds`): o PRÓPRIO repositório fica vermelho (não só
// laranja por efeito colateral de cascata), e quem depende dele por integração ativa também aparece
// impactado.
test("com brokenRepoIds, o heading do próprio repositório vira 🔴 e o vizinho que depende dele fica impactado", () => {
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
  const ctx = buildRenderContext([orderService, shippingService], []);
  const brokenRepoIds = ["order-service"];

  const incomingToOrderService = [
    edge({ id: "e1", source: "shipping-service", target: "order-service", type: "outbound_http" }),
  ];
  const orderNote = renderRepoNote(orderService, "repo-testes", [], incomingToOrderService, ctx, brokenRepoIds);
  assert.match(orderNote, /^# 🔴 order-service/m);

  // A edge em si não muda de status sozinha dentro de renderRepoNote (quem aplica a cascata nas
  // EDGES é applyCascadingImpact, chamado antes, em obsidianWriter.ts) — mas o ego-graph do
  // VIZINHO precisa saber que order-service está broken pra colorir o NÓ dele de vermelho mesmo
  // numa edge que, isolada, ainda está "active" neste teste.
  const outgoingFromShipping = [
    edge({ id: "e1", source: "shipping-service", target: "order-service", type: "outbound_http" }),
  ];
  const shippingNote = renderRepoNote(shippingService, "repo-testes", outgoingFromShipping, [], ctx, brokenRepoIds);
  assert.ok(shippingNote.includes("classDef brokenNode"), "o ego-graph de shipping-service deveria colorir order-service de vermelho");
});
