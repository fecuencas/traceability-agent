import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphSnapshot } from "../graph/types.js";
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
