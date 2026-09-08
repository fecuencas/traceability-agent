import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveSnapshot } from "../graph/graphSnapshot.js";
import { runImpactCheck } from "./impactCheck.js";

function makeGroup(): { projectRoot: string; configPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "impact-check-"));
  const repoPath = path.join(projectRoot, "order-service");
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ name: "order-service", version: "1.0.0" }), "utf8");

  const configPath = path.join(projectRoot, ".traceability", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ groupId: "test-group", repos: [{ id: "order-service", path: "./order-service", coordinates: ["order-service"] }] }),
    "utf8",
  );
  return { projectRoot, configPath };
}

test("persist:false não sobrescreve o snapshot salvo", () => {
  const { projectRoot, configPath } = makeGroup();
  const staleSnapshot = { group: "test-group", generatedAt: "2020-01-01T00:00:00.000Z", repos: [], edges: [], serviceNodes: [] };
  saveSnapshot(configPath, staleSnapshot);

  runImpactCheck({ configPath, repoId: "order-service", persist: false });

  const stateFile = path.join(projectRoot, ".traceability", "state", "graph-snapshot.json");
  const stillThere = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(stillThere.generatedAt, "2020-01-01T00:00:00.000Z");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("persist:true (default) atualiza o snapshot salvo", () => {
  const { projectRoot, configPath } = makeGroup();
  const staleSnapshot = { group: "test-group", generatedAt: "2020-01-01T00:00:00.000Z", repos: [], edges: [], serviceNodes: [] };
  saveSnapshot(configPath, staleSnapshot);

  runImpactCheck({ configPath, repoId: "order-service" });

  const stateFile = path.join(projectRoot, ".traceability", "state", "graph-snapshot.json");
  const updated = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.notEqual(updated.generatedAt, "2020-01-01T00:00:00.000Z");

  fs.rmSync(projectRoot, { recursive: true, force: true });
});
