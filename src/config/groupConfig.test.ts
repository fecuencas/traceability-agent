import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadGroupConfig } from "./groupConfig.js";

function writeConfig(rootDir: string, config: unknown): string {
  const configDir = path.join(rootDir, ".traceability");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

test("loadGroupConfig carrega normalmente um groupId/repos[].id seguros", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "groupconfig-"));
  const configPath = writeConfig(rootDir, {
    groupId: "meu-sistema",
    repos: [{ id: "repo-a", path: "./repo-a", coordinates: [] }],
  });

  const config = loadGroupConfig(configPath);

  assert.equal(config.groupId, "meu-sistema");
  assert.equal(config.repos[0].id, "repo-a");

  fs.rmSync(rootDir, { recursive: true, force: true });
});

// O achado de segurança desta sessão: groupId/repos[].id viram segmento de caminho de arquivo em
// obsidianWriter.ts (`Repos/<groupId>/<repoId>.md`) — sem validar aqui, na leitura do config, um id
// tipo "../../../etc/algo" escreveria fora do vault quando o path.join resolvesse os "..".
test("loadGroupConfig rejeita groupId com tentativa de path traversal", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "groupconfig-"));
  const configPath = writeConfig(rootDir, {
    groupId: "../../../../tmp/evil",
    repos: [{ id: "repo-a", path: "./repo-a", coordinates: [] }],
  });

  assert.throws(() => loadGroupConfig(configPath), /groupId.*inválido/s);

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("loadGroupConfig rejeita repos[].id com barra (escaparia da subpasta do grupo)", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "groupconfig-"));
  const configPath = writeConfig(rootDir, {
    groupId: "meu-sistema",
    repos: [{ id: "../escape", path: "./repo-a", coordinates: [] }],
  });

  assert.throws(() => loadGroupConfig(configPath), /repos\[\]\.id.*inválido/s);

  fs.rmSync(rootDir, { recursive: true, force: true });
});
