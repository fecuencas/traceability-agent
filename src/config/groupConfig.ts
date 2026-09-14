import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeId } from "./safeId.js";

const DEFAULT_CONFIG_RELATIVE_PATH = path.join(".traceability", "config.json");
const REGISTRY_PATH = path.join(os.homedir(), ".traceability-agent", "registry.json");

export interface GroupRepoConfig {
  id: string;
  /** Caminho absoluto ou relativo ao diretório do arquivo de config — obrigatório SÓ se `manifestPath`
   * não for informado (o repo então é re-escaneado agora); com `manifestPath`, é opcional. */
  path?: string;
  /** Resolve este repo a partir de um manifesto pré-gerado (`writeManifest`/CLI `scan`) em vez de
   * re-escanear agora — permite descrever um grupo sem checkout local de todos os repos. Relativo
   * ao diretório do config, como `path`. */
  manifestPath?: string;
  language?: string;
  buildSystem?: string;
  coordinates: string[];
  /** Base URLs/hosts que este repo expõe — usado para resolver sinais outbound_http de outros repos do grupo. */
  endpoints?: string[];
}

export interface GroupConfig {
  groupId: string;
  /** Caminho absoluto do arquivo de config carregado — usado para localizar o state/ ao lado dele. */
  configPath: string;
  repos: GroupRepoConfig[];
  /** Auto-descobre `.traceability/manifest.json` em cada subpasta imediata deste diretório —
   * mesclado com `repos[]` (entradas explícitas em `repos[]` vencem quando o mesmo repoId aparece
   * nos dois, já que só elas podem carregar `endpoints`). Relativo ao diretório do config. */
  manifestsDir?: string;
  /** Vault do Obsidian DEDICADO deste grupo — se informado, `update_obsidian_graph`/
   * `generate_html_report` gravam aqui em vez do vault compartilhado padrão
   * (`DEFAULT_VAULT_PATH`), e a visão macro (`index.md`) deste vault só lista grupos que também
   * apontam pra ele (nunca mistura com grupos do vault compartilhado ou de outro vault dedicado).
   * Só perde efeito se a tool receber `vaultPath` explícito na chamada (esse sempre vence). Relativo
   * ao diretório do config, como `path`/`manifestPath`. */
  vaultPath?: string;
}

interface RawGroupConfig {
  groupId: string;
  repos: GroupRepoConfig[];
  manifestsDir?: string;
  vaultPath?: string;
}

/**
 * Resolve o caminho do arquivo de config: se `configPath` for informado, usa ele (relativo ao cwd se
 * não for absoluto); senão, procura `.traceability/config.json` a partir do diretório atual — o
 * projeto que quiser ser rastreado pelo traceability-agent cria esse arquivo na própria raiz.
 */
export function resolveConfigPath(configPath?: string): string {
  if (configPath) return path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  return path.resolve(process.cwd(), DEFAULT_CONFIG_RELATIVE_PATH);
}

export function loadGroupConfig(configPath?: string): GroupConfig {
  const resolvedPath = resolveConfigPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config de rastreabilidade não encontrada em ${resolvedPath}. Crie um arquivo .traceability/config.json ` +
        `na raiz do projeto (ou passe configPath explicitamente) com { "groupId": "...", "repos": [...] }.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as RawGroupConfig;
  // groupId/repos[].id viram nome de arquivo/pasta dentro do vault (obsidianWriter.ts) — validados
  // aqui, na fronteira de leitura do config, para que um id malicioso ("../../../etc/algo") seja
  // rejeitado com um erro claro em vez de escrever fora do vault mais adiante.
  assertSafeId(raw.groupId, `groupId em ${resolvedPath}`);
  for (const repo of raw.repos) {
    assertSafeId(repo.id, `repos[].id em ${resolvedPath}`);
  }
  // resolvedPath = <projectRoot>/.traceability/config.json -> paths relativos são relativos a <projectRoot>,
  // não à própria pasta .traceability (senão "./order-service" resolveria para dentro de .traceability/).
  const projectRoot = path.dirname(path.dirname(resolvedPath));
  const resolveRelative = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(projectRoot, value));

  return {
    groupId: raw.groupId,
    configPath: resolvedPath,
    repos: raw.repos.map((repo) => ({
      ...repo,
      path: repo.path ? resolveRelative(repo.path) : undefined,
      manifestPath: repo.manifestPath ? resolveRelative(repo.manifestPath) : undefined,
    })),
    manifestsDir: raw.manifestsDir ? resolveRelative(raw.manifestsDir) : undefined,
    vaultPath: raw.vaultPath ? resolveRelative(raw.vaultPath) : undefined,
  };
}

interface RegistryEntry {
  groupId: string;
  configPath: string;
  lastUpdatedAt: string;
}

interface Registry {
  entries: RegistryEntry[];
}

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return { entries: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
}

/** Registra (ou atualiza) este config no índice leve usado para montar a visão macro entre projetos. */
export function recordGroupInRegistry(groupId: string, configPath: string, timestamp: string): void {
  const registry = loadRegistry();
  const existingIndex = registry.entries.findIndex((entry) => entry.configPath === configPath);
  const entry: RegistryEntry = { groupId, configPath, lastUpdatedAt: timestamp };
  if (existingIndex === -1) {
    registry.entries.push(entry);
  } else {
    registry.entries[existingIndex] = entry;
  }
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
}

export function listRegisteredGroups(): RegistryEntry[] {
  return loadRegistry().entries;
}

export function removeGroupFromRegistry(configPath: string): void {
  const registry = loadRegistry();
  registry.entries = registry.entries.filter((entry) => entry.configPath !== configPath);
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
}
