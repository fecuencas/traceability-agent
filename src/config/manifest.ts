import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyzeRepository } from "../adapters/adapterRegistry.js";
import type { RepoAnalysisResult } from "../adapters/types.js";

export const MANIFEST_VERSION = 1 as const;

const MANIFEST_RELATIVE_PATH = path.join(".traceability", "manifest.json");

/**
 * O que um repositório publica sozinho ao ser escaneado sem conhecer nenhum irmão — permite rodar
 * o agente num único repositório (ex: dentro do próprio CI/pre-commit dele) e, separadamente, uma
 * agregação ler os manifestos de N repositórios pra montar o grafo cruzado
 * (`src/config/groupAnalysis.ts`), sem exigir que todos estejam listados num config central.
 */
export interface RepoManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  repoId: string;
  generatedAt: string;
  /** Best-effort (`git rev-parse HEAD` no repoPath) — undefined se não for um repositório git ou git não estiver disponível. */
  commitSha?: string;
  /** Exatamente o que `analyzeRepository()` já retorna — nenhuma lógica de detecção nova aqui. */
  analysis: RepoAnalysisResult;
}

function tryGetCommitSha(repoPath: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function manifestPathFor(repoPath: string): string {
  return path.join(repoPath, MANIFEST_RELATIVE_PATH);
}

/** Analisa `repoPath` sozinho (sem nenhum config de grupo) e grava o manifesto — em
 * `<repoPath>/.traceability/manifest.json` por padrão, ou em `outPath` se informado. */
export function writeManifest(repoPath: string, repoId: string, outPath?: string): RepoManifest {
  const analysis = analyzeRepository(repoPath, repoId);
  const manifest: RepoManifest = {
    manifestVersion: MANIFEST_VERSION,
    repoId,
    generatedAt: analysis.scannedAt,
    commitSha: tryGetCommitSha(repoPath),
    analysis,
  };
  const resolvedOutPath = outPath ?? manifestPathFor(repoPath);
  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.writeFileSync(resolvedOutPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export function readManifest(manifestPath: string): RepoManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RepoManifest;
  if (raw.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(
      `Manifesto em ${manifestPath} tem manifestVersion ${String(raw.manifestVersion)}, esperado ${MANIFEST_VERSION}. ` +
        "Regenere o manifesto com a versão atual do traceability-agent.",
    );
  }
  return raw;
}

/** Procura `.traceability/manifest.json` em cada subpasta IMEDIATA de `rootDir` — não recursivo,
 * mesmo espírito de "um repo = uma pasta de primeiro nível" que o `config.json` central já assume
 * pra `path`. Manifesto corrompido ou de versão incompatível é ignorado (não derruba a agregação
 * inteira por causa de UM repo com manifesto ruim). */
export function discoverManifests(rootDir: string): RepoManifest[] {
  if (!fs.existsSync(rootDir)) return [];
  const manifests: RepoManifest[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidatePath = manifestPathFor(path.join(rootDir, entry.name));
    if (!fs.existsSync(candidatePath)) continue;
    try {
      manifests.push(readManifest(candidatePath));
    } catch {
      // manifesto corrompido/versão incompatível — ignora este repo, não interrompe a descoberta dos outros
    }
  }
  return manifests;
}
