import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { phpComposerAdapter } from "./phpComposerAdapter.js";

function makeRepo(files: Record<string, string>): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "php-repo-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return repoPath;
}

const COMPOSER_JSON = JSON.stringify({
  name: "acme/order-service",
  version: "1.0.0",
  require: { php: "^8.2", "guzzlehttp/guzzle": "^7.8" },
});

test("matches só quando existe composer.json", () => {
  const repoPath = makeRepo({ "composer.json": COMPOSER_JSON });
  assert.equal(phpComposerAdapter.matches(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("extrai coordinates e dependência, ignorando a constraint de php em si", () => {
  const repoPath = makeRepo({ "composer.json": COMPOSER_JSON });

  const result = phpComposerAdapter.analyze(repoPath, "order-service");

  assert.equal(result.coordinates.packageName, "acme/order-service");
  const deps = result.signals.filter((s) => s.type === "published_artifact_dependency");
  assert.equal(deps.length, 1);
  assert.equal(deps[0].target.value, "guzzlehttp/guzzle");

  fs.rmSync(repoPath, { recursive: true, force: true });
});

// PHP é o adapter com maior risco de colisão (classe de domínio comum chamada "Client") — por isso
// exige o FQCN completo do Guzzle, não `new Client(` bare. Confirma que uma classe de domínio
// homônima NÃO gera falso sinal.
test("não confunde uma classe de domínio chamada Client com o client HTTP real", () => {
  const repoPath = makeRepo({
    "composer.json": COMPOSER_JSON,
    "src/Client.php": [
      "<?php",
      "namespace App\\Domain\\Payment;",
      "class Client {",
      "  public function charge() {}",
      "}",
    ].join("\n"),
  });

  const result = phpComposerAdapter.analyze(repoPath, "order-service");
  assert.equal(result.signals.filter((s) => s.type === "outbound_http").length, 0);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

// Gap conhecido e documentado no adapter: só o estilo encadeado numa linha só é detectado —
// construtor e chamada em variável separada em linhas diferentes NÃO é (exigir `->get(`/`->post(`
// sozinho reintroduziria o mesmo risco de colisão que o FQCN completo foi escolhido pra evitar).
test("detecta chamada real ao Guzzle via FQCN completo (estilo encadeado numa linha só)", () => {
  const repoPath = makeRepo({
    "composer.json": COMPOSER_JSON,
    "src/OrderClient.php": [
      "<?php",
      "class OrderClient {",
      '  public function fetch() { return (new \\GuzzleHttp\\Client())->get("http://localhost:8081/orders"); }',
      "}",
    ].join("\n"),
  });

  const result = phpComposerAdapter.analyze(repoPath, "order-service");
  const httpSignal = result.signals.find((s) => s.type === "outbound_http");
  assert.equal(httpSignal?.target.kind, "url");
  assert.equal(httpSignal?.target.value, "http://localhost:8081/orders");

  fs.rmSync(repoPath, { recursive: true, force: true });
});
