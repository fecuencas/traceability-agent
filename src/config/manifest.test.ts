import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverManifests, manifestPathFor, readManifest, writeManifest } from "./manifest.js";

function makeNodeRepo(rootDir: string, dirName: string): string {
  const repoPath = path.join(rootDir, dirName);
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: dirName, version: "1.0.0" }), "utf8");
  return repoPath;
}

test("writeManifest analisa o repo sozinho e grava .traceability/manifest.json", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  const repoPath = makeNodeRepo(rootDir, "standalone-service");

  const manifest = writeManifest(repoPath, "standalone-service");

  assert.equal(manifest.repoId, "standalone-service");
  assert.equal(manifest.analysis.language, "node");
  assert.ok(fs.existsSync(manifestPathFor(repoPath)));

  const reread = readManifest(manifestPathFor(repoPath));
  // Compara via round-trip JSON dos dois lados: `commitSha: undefined` existe como chave no objeto
  // em memória mas nunca no arquivo (JSON.stringify descarta undefined), então comparar direto
  // acusaria diferença onde não há nenhuma diferença observável de verdade.
  assert.deepEqual(reread, JSON.parse(JSON.stringify(manifest)));

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("readManifest rejeita manifestVersion incompatível", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  const manifestPath = path.join(rootDir, "bad-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ manifestVersion: 999, repoId: "x" }), "utf8");

  assert.throws(() => readManifest(manifestPath), /manifestVersion/);

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("discoverManifests encontra manifestos em cada subpasta imediata, ignora as sem manifesto", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  const repoA = makeNodeRepo(rootDir, "repo-a");
  makeNodeRepo(rootDir, "repo-b"); // sem manifesto gerado
  writeManifest(repoA, "repo-a");

  const discovered = discoverManifests(rootDir);

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].repoId, "repo-a");

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("discoverManifests ignora manifesto corrompido sem derrubar a descoberta dos outros", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  const repoA = makeNodeRepo(rootDir, "repo-a");
  writeManifest(repoA, "repo-a");
  const repoBPath = makeNodeRepo(rootDir, "repo-b");
  fs.mkdirSync(path.join(repoBPath, ".traceability"), { recursive: true });
  fs.writeFileSync(path.join(repoBPath, ".traceability", "manifest.json"), JSON.stringify({ manifestVersion: 999 }), "utf8");

  const discovered = discoverManifests(rootDir);

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].repoId, "repo-a");

  fs.rmSync(rootDir, { recursive: true, force: true });
});
