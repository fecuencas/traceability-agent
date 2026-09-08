#!/usr/bin/env node
import path from "node:path";
import { writeManifest } from "../config/manifest.js";

/**
 * CLI standalone — não passa pelo protocolo MCP, pensado para rodar de dentro do próprio CI/
 * pre-commit de UM repositório, sem cliente MCP disponível (ver Fase 8 do plano de produtização:
 * git hook e gate de CI vão reaproveitar este binário). Hoje só tem o subcomando `scan`; novos
 * subcomandos entram aqui conforme as próximas superfícies forem implementadas.
 */

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      flags[key] = args[i + 1];
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function runScan(args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const repoPath = path.resolve(positional[0] ?? process.cwd());
  const repoId = flags["repo-id"] ?? path.basename(repoPath);
  const outPath = flags["out"] ? path.resolve(flags["out"]) : undefined;

  const manifest = writeManifest(repoPath, repoId, outPath);
  console.log(JSON.stringify(manifest, null, 2));
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "scan":
      runScan(rest);
      break;
    default:
      console.error(
        [
          "Uso: traceability-agent scan [repoPath] [--repo-id <id>] [--out <path>]",
          "",
          "Analisa repoPath (default: diretório atual) sozinho, sem conhecer nenhum repositório irmão, e grava",
          "o manifesto em <repoPath>/.traceability/manifest.json (ou em --out, se informado).",
        ].join("\n"),
      );
      process.exitCode = command ? 1 : 0;
  }
}

main();
