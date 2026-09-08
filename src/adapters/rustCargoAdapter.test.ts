import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rustCargoAdapter } from "./rustCargoAdapter.js";

function makeRepo(files: Record<string, string>): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rust-repo-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return repoPath;
}

const CARGO_TOML = [
  "[package]",
  'name = "order-service"',
  'version = "1.0.0"',
  'edition = "2021"',
  "",
  "[dependencies]",
  'reqwest = { version = "0.11", features = ["json"] }',
  'serde = "1.0"',
].join("\n");

test("matches só quando existe Cargo.toml", () => {
  const repoPath = makeRepo({ "Cargo.toml": CARGO_TOML });
  assert.equal(rustCargoAdapter.matches(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("extrai name/version do [package] e dependências em forma simples e em tabela", () => {
  const repoPath = makeRepo({ "Cargo.toml": CARGO_TOML });

  const result = rustCargoAdapter.analyze(repoPath, "order-service");

  assert.equal(result.coordinates.packageName, "order-service");
  assert.equal(result.coordinates.version, "1.0.0");
  const deps = result.signals.filter((s) => s.type === "published_artifact_dependency").map((s) => s.target.value);
  assert.deepEqual(deps.sort(), ["reqwest", "serde"]);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta chamada HTTP real via reqwest:: e ignora declaração de struct própria (Rust: struct X)", () => {
  const repoPath = makeRepo({
    "Cargo.toml": CARGO_TOML,
    "src/main.rs": [
      "// pub struct Client é o wrapper idiomático de praticamente todo crate Rust — não deve",
      "// colidir, já que o regex de detecção exige o módulo real (reqwest::), nunca um Client bare.",
      "pub struct Client {",
      "    base_url: String,",
      "}",
      "",
      'fn fetch_order() { reqwest::get("http://localhost:8081/orders"); }',
    ].join("\n"),
  });

  const result = rustCargoAdapter.analyze(repoPath, "order-service");

  const httpSignals = result.signals.filter((s) => s.type === "outbound_http");
  assert.equal(httpSignals.length, 1);
  assert.equal(httpSignals[0].target.kind, "url");
  assert.equal(httpSignals[0].target.value, "http://localhost:8081/orders");

  fs.rmSync(repoPath, { recursive: true, force: true });
});
