import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GroupRepoConfig } from "../config/groupConfig.js";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge, GraphSnapshot } from "../graph/types.js";
import { writeGraphToVault } from "./obsidianWriter.js";

function makeRepo(repoId: string): RepoAnalysisResult {
  return {
    repoId,
    repoPath: "/tmp/repo",
    language: "node",
    buildSystem: "npm",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
  };
}

function makeSnapshot(group: string, repoId: string): GraphSnapshot {
  return {
    group,
    generatedAt: new Date(0).toISOString(),
    repos: [makeRepo(repoId)],
    edges: [],
    serviceNodes: [],
  };
}

// Achado real em produção (sessão 2026-09): o vault é compartilhado entre todos os grupos
// rastreados na máquina, e o nome do arquivo de nota de repo usava só o repoId, sem o groupId —
// dois grupos independentes que por coincidência usam o mesmo repoId (ex: dois sistemas diferentes
// cada um com um "order-service" próprio) sobrescreviam a nota um do outro em silêncio. Resolvido
// DE VEZ namespaceando por grupo (`Repos/<groupId>/<repoId>.md`) — dois grupos com o mesmo repoId
// não colidem mais estruturalmente (escrevem em arquivos DIFERENTES), então nem chegam a acionar o
// guard de colisão abaixo.
test("dois grupos diferentes com o mesmo repoId gravam em arquivos separados, sem colisão nenhuma", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));

  const first = writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "order-service"));
  assert.equal(first.collisions.length, 0);

  const second = writeGraphToVault(vaultPath, makeSnapshot("sistema-b", "order-service"));
  assert.equal(second.collisions.length, 0);

  const noteA = fs.readFileSync(path.join(vaultPath, "Repos", "sistema-a", "order-service.md"), "utf8");
  const noteB = fs.readFileSync(path.join(vaultPath, "Repos", "sistema-b", "order-service.md"), "utf8");
  assert.match(noteA, /group:\s*"sistema-a"/);
  assert.match(noteB, /group:\s*"sistema-b"/);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("o mesmo grupo regravando seu próprio repoId funciona normalmente (não é colisão)", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));

  writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "order-service"));
  const second = writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "order-service"));

  assert.equal(second.collisions.length, 0);
  assert.ok(second.filesWritten.some((f) => f.endsWith(path.join("Repos", "sistema-a", "order-service.md"))));

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("repoId novo (sem colisão) é gravado normalmente", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));

  const result = writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "novo-repo"));
  assert.equal(result.collisions.length, 0);
  assert.ok(result.filesWritten.some((f) => f.endsWith(path.join("Repos", "sistema-a", "novo-repo.md"))));

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Path traversal: mesmo que um repoId/groupId malicioso passasse pelos loaders (config/manifest),
// writeGraphToVault precisa recusar sozinho, já que monta o caminho da nota concatenando esses ids —
// um "../../../tmp/evil" resolveria fora de vaultPath se não fosse validado aqui.
test("writeGraphToVault rejeita repoId com tentativa de path traversal, sem escrever nada fora do vault", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const outsideMarker = path.join(vaultPath, "..", `${path.basename(vaultPath)}-evil.md`);

  assert.throws(() => writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "../../evil")), /repoId.*inválido/s);
  assert.equal(fs.existsSync(outsideMarker), false);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("writeGraphToVault rejeita groupId com tentativa de path traversal", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));

  assert.throws(() => writeGraphToVault(vaultPath, makeSnapshot("../../evil", "order-service")), /groupId.*inválido/s);

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// Segunda camada de defesa que sobra depois do namespacing por pasta: um arquivo plantado à mão (ou
// resquício de uma versão anterior do agente, ou uma nota tamperada) dentro da subpasta do grupo,
// mas com um `group:` de frontmatter DIFERENTE do esperado, ainda não é sobrescrito.
test("nota com frontmatter de outro grupo, plantada manualmente na subpasta certa, não é sobrescrita", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const filePath = path.join(vaultPath, "Repos", "sistema-a", "order-service.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '---\ngroup: "outro-grupo-qualquer"\n---\nconteúdo manual', "utf8");

  const result = writeGraphToVault(vaultPath, makeSnapshot("sistema-a", "order-service"));

  assert.equal(result.collisions.length, 1);
  assert.match(result.collisions[0], /order-service/);
  assert.equal(fs.readFileSync(filePath, "utf8"), '---\ngroup: "outro-grupo-qualquer"\n---\nconteúdo manual');

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "source" | "target" | "type">): GraphEdge {
  return {
    confidence: "high",
    detectorId: "test",
    evidence: { file: "test.txt", snippet: "" },
    status: "active",
    ...overrides,
  };
}

// Pedido real de usuário: repos com nome corporativo muito longo deixam os nós do Graph View
// NATIVO do Obsidian (que rotula pelo nome do ARQUIVO, não por nenhum alias) enormes/ilegíveis.
// `maxRepoNameLength` resolve isso truncando só o nome do arquivo — repoId completo continua em
// todo o resto (frontmatter, conteúdo, diagramas Mermaid).
test("maxRepoNameLength trunca o nome do ARQUIVO da nota, mas repoId completo continua no frontmatter/conteúdo", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const longRepoId = "acme-platform-payments-checkout-service";
  const repoConfigs: GroupRepoConfig[] = [{ id: longRepoId, coordinates: [] }];

  const result = writeGraphToVault(vaultPath, makeSnapshot("sistema-a", longRepoId), repoConfigs, 20);

  const truncatedFiles = fs.readdirSync(path.join(vaultPath, "Repos", "sistema-a"));
  assert.equal(truncatedFiles.length, 1);
  const [fileName] = truncatedFiles;
  assert.notEqual(fileName, `${longRepoId}.md`, "o arquivo não deveria usar o repoId completo");
  assert.ok(fileName.startsWith(longRepoId.slice(0, 20)), "o arquivo deveria começar com o prefixo truncado");
  assert.ok(result.filesWritten.some((f) => f.endsWith(fileName)));

  const content = fs.readFileSync(path.join(vaultPath, "Repos", "sistema-a", fileName), "utf8");
  assert.ok(content.includes(`repoId: "${longRepoId}"`), "o frontmatter deveria manter o repoId completo");
  assert.ok(content.includes(`# 🟢 ${longRepoId}`), "o heading da nota deveria manter o repoId completo");

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

test("displayName explícito grava a nota direto com esse nome de arquivo", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const longRepoId = "acme-platform-payments-checkout-service";
  const repoConfigs: GroupRepoConfig[] = [{ id: longRepoId, coordinates: [], displayName: "checkout" }];

  writeGraphToVault(vaultPath, makeSnapshot("sistema-a", longRepoId), repoConfigs);

  const filePath = path.join(vaultPath, "Repos", "sistema-a", "checkout.md");
  assert.ok(fs.existsSync(filePath), "a nota deveria estar em Repos/sistema-a/checkout.md");
  const content = fs.readFileSync(filePath, "utf8");
  assert.ok(content.includes(`repoId: "${longRepoId}"`));

  fs.rmSync(vaultPath, { recursive: true, force: true });
});

// O wikilink precisa apontar pro ARQUIVO certo (o slug, senão o link fica "unresolved" no
// Obsidian), mas continuar EXIBINDO o repoId completo como texto — só o Graph View nativo (que lê
// o nome do arquivo, não o alias do link) é afetado pelo encurtamento.
test("wikilink de uma integração aponta pro arquivo com nome truncado, mas exibe o repoId completo como texto", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const longRepoId = "acme-platform-payments-checkout-service";
  const repoConfigs: GroupRepoConfig[] = [{ id: longRepoId, coordinates: [] }, { id: "shipping-service", coordinates: [] }];
  const snapshot: GraphSnapshot = {
    group: "sistema-a",
    generatedAt: new Date(0).toISOString(),
    repos: [makeRepo(longRepoId), makeRepo("shipping-service")],
    edges: [edge({ id: "e1", source: "shipping-service", target: longRepoId, type: "outbound_http" })],
    serviceNodes: [],
  };

  writeGraphToVault(vaultPath, snapshot, repoConfigs, 20);

  // `renderIntegrationNote` (Integrations/sistema-a/e1.md) é quem efetivamente linka pro repo de
  // ORIGEM/DESTINO de uma edge via `nodeLink`/`repoLink` — a nota do próprio repo (shipping-
  // service.md) só linka pra INTEGRAÇÃO em si (edge.id), não direto pro outro repo.
  const integrationNote = fs.readFileSync(path.join(vaultPath, "Integrations", "sistema-a", "e1.md"), "utf8");
  const truncatedSlug = fs.readdirSync(path.join(vaultPath, "Repos", "sistema-a")).find((f) => f !== "shipping-service.md");
  assert.ok(truncatedSlug);
  const slugWithoutExt = truncatedSlug!.replace(/\.md$/, "");

  assert.ok(
    integrationNote.includes(`[[Repos/sistema-a/${slugWithoutExt}|${longRepoId}]]`),
    "o wikilink pro repo de destino deveria apontar pro arquivo truncado mas exibir o repoId completo como alias",
  );

  fs.rmSync(vaultPath, { recursive: true, force: true });
});
