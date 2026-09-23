import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RepoAnalysisResult } from "../adapters/types.js";
import { checkPublishedArtifactIntegrity } from "./integrityChecker.js";

function makeRepo(overrides: Partial<RepoAnalysisResult> & Pick<RepoAnalysisResult, "repoId" | "repoPath">): RepoAnalysisResult {
  return {
    language: "java",
    buildSystem: "maven",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [],
    ...overrides,
  };
}

function writeJavaFile(repoPath: string, fqcn: string, content: string): void {
  const relativePath = fqcn.replace(/\./g, path.sep) + ".java";
  const filePath = path.join(repoPath, "src", "main", "java", relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// Achado #1: um groupId "pai" (com.repotestes, do shared-utils) não deve reivindicar um import que
// na verdade pertence a um groupId "irmão" mais específico de outro repo do grupo
// (com.repotestes.fulfillment, do fulfillment-service) — sem essa exclusão, a checagem de
// integridade de billing-service -> shared-utils cobrava a existência de uma classe que nunca
// existiu em shared-utils, porque ela pertence ao fulfillment-service.
test("não reivindica import de um groupId irmão mais específico (Achado #1)", () => {
  const sourceRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "billing-"));
  const targetRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "shared-utils-"));

  writeJavaFile(
    sourceRepoPath,
    "com.repotestes.billing.InvoiceBuilder",
    "package com.repotestes.billing;\nimport com.repotestes.shared.MoneyFormatter;\nimport com.repotestes.fulfillment.OrderFulfillmentHandler;\nclass InvoiceBuilder {}\n",
  );
  // Só a classe REAL de shared-utils existe no repoPath do alvo — a do fulfillment-service nunca
  // deveria ter sido checada aqui.
  writeJavaFile(targetRepoPath, "com.repotestes.shared.MoneyFormatter", "package com.repotestes.shared;\nclass MoneyFormatter {}\n");

  const sourceRepo = makeRepo({ repoId: "billing-service", repoPath: sourceRepoPath, coordinates: { groupId: "com.repotestes", artifactId: "billing-service", version: "1.0.0" } });
  const targetRepo = makeRepo({ repoId: "shared-utils", repoPath: targetRepoPath, coordinates: { groupId: "com.repotestes", artifactId: "shared-utils", version: "1.0.0" } });
  const siblingRepo = makeRepo({
    repoId: "fulfillment-service",
    repoPath: fs.mkdtempSync(path.join(os.tmpdir(), "fulfillment-")),
    coordinates: { groupId: "com.repotestes.fulfillment", artifactId: "fulfillment-service", version: "1.0.0" },
  });

  const result = checkPublishedArtifactIntegrity(sourceRepo, targetRepo, [sourceRepo, targetRepo, siblingRepo]);
  assert.equal(result.broken, false, result.reason ?? "expected the artifact dependency to not be broken");

  fs.rmSync(sourceRepoPath, { recursive: true, force: true });
  fs.rmSync(targetRepoPath, { recursive: true, force: true });
  fs.rmSync(siblingRepo.repoPath, { recursive: true, force: true });
});

test("marca quebrado quando a classe importada de verdade não existe mais no alvo", () => {
  const sourceRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "billing-"));
  const targetRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "shared-utils-"));

  writeJavaFile(sourceRepoPath, "com.repotestes.billing.InvoiceBuilder", "package com.repotestes.billing;\nimport com.repotestes.shared.MoneyFormatter;\nclass InvoiceBuilder {}\n");
  // Alvo não tem mais MoneyFormatter.java.

  const sourceRepo = makeRepo({ repoId: "billing-service", repoPath: sourceRepoPath, coordinates: { groupId: "com.repotestes", artifactId: "billing-service", version: "1.0.0" } });
  const targetRepo = makeRepo({ repoId: "shared-utils", repoPath: targetRepoPath, coordinates: { groupId: "com.repotestes", artifactId: "shared-utils", version: "1.0.0" } });

  const result = checkPublishedArtifactIntegrity(sourceRepo, targetRepo, [sourceRepo, targetRepo]);
  assert.equal(result.broken, true);

  fs.rmSync(sourceRepoPath, { recursive: true, force: true });
  fs.rmSync(targetRepoPath, { recursive: true, force: true });
});

// Fase 6 (config descentralizado): um repo resolvido via manifesto pode não ter checkout local
// nesta máquina — tratar "não consigo checar" como "quebrado" seria um falso-positivo.
test("não marca quebrado quando o repoPath do alvo não existe localmente (repo via manifesto)", () => {
  const sourceRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "billing-"));
  writeJavaFile(sourceRepoPath, "com.repotestes.billing.InvoiceBuilder", "package com.repotestes.billing;\nimport com.repotestes.shared.MoneyFormatter;\nclass InvoiceBuilder {}\n");

  const sourceRepo = makeRepo({ repoId: "billing-service", repoPath: sourceRepoPath, coordinates: { groupId: "com.repotestes", artifactId: "billing-service", version: "1.0.0" } });
  const targetRepo = makeRepo({
    repoId: "shared-utils",
    repoPath: "/caminho/que/nao/existe/nesta/maquina",
    coordinates: { groupId: "com.repotestes", artifactId: "shared-utils", version: "1.0.0" },
  });

  const result = checkPublishedArtifactIntegrity(sourceRepo, targetRepo, [sourceRepo, targetRepo]);
  assert.equal(result.broken, false);

  fs.rmSync(sourceRepoPath, { recursive: true, force: true });
});
