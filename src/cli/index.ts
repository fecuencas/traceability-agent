#!/usr/bin/env node
import path from "node:path";
import { writeManifest } from "../config/manifest.js";
import { runUpdateObsidianGraph } from "../tools/updateObsidianGraph.js";
import { runGenerateHtmlReport } from "../tools/generateHtmlReport.js";
import { runGenerateImpactReport } from "../tools/generateImpactReport.js";
import { runImpactCheck } from "../impact/impactCheck.js";

/**
 * CLI standalone — não passa pelo protocolo MCP. Duas razões de existir: (1) rodar de dentro do
 * próprio CI/pre-commit de UM repositório, sem cliente MCP disponível (ver Fase 8 do plano de
 * produtização: git hook e gate de CI vão reaproveitar este binário); (2) dar a quem não usa um
 * cliente MCP (ou só quer rodar do terminal mesmo) acesso ao mesmo fluxo de dia a dia que a tool MCP
 * oferece pra uma IA — scan, grafo/vault, relatório HTML, análise de impacto. Cada subcomando abaixo
 * chama exatamente a mesma função `runX` que a tool MCP correspondente usa (`src/tools/*.ts`), pra
 * nunca divergir do que o agente faz quando chamado por uma IA.
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

function runUpdateGraph(args: string[]): void {
  const { flags } = parseFlags(args);
  const result = runUpdateObsidianGraph({ configPath: flags["config"], vaultPath: flags["vault"] });
  console.log(JSON.stringify(result, null, 2));
}

function runHtmlReport(args: string[]): void {
  const { flags } = parseFlags(args);
  const result = runGenerateHtmlReport({ configPath: flags["config"], vaultPath: flags["vault"] });
  console.log(JSON.stringify(result, null, 2));
}

function runImpact(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags["repo-id"]) throw new Error("--repo-id é obrigatório (o repositório alterado cujo impacto quer ver).");
  const diff = runImpactCheck({
    configPath: flags["config"],
    repoId: flags["repo-id"],
    persist: flags["no-persist"] === undefined,
  });
  console.log(JSON.stringify(diff, null, 2));
}

function runImpactReport(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags["repo-id"]) throw new Error("--repo-id é obrigatório (o repositório cujo impacto está sendo reportado).");
  const result = runGenerateImpactReport({
    configPath: flags["config"],
    repoId: flags["repo-id"],
    vaultPath: flags["vault"],
  });
  console.log(JSON.stringify(result, null, 2));
}

function printUsage(): void {
  console.error(
    [
      "Uso: traceability-agent <comando> [opções]",
      "",
      "  scan [repoPath] [--repo-id <id>] [--out <path>]",
      "      Analisa repoPath (default: diretório atual) sozinho, sem conhecer nenhum repositório",
      "      irmão, e grava o manifesto em <repoPath>/.traceability/manifest.json (ou em --out).",
      "",
      "  update-graph [--config <path>] [--vault <path>]",
      "      Escaneia o grupo inteiro (.traceability/config.json do diretório atual, ou --config) e",
      "      grava/atualiza as notas do vault Obsidian, incluindo a visão macro (index.md).",
      "",
      "  html-report [--config <path>] [--vault <path>]",
      "      Gera o relatório HTML autocontido do grupo em Reports/html-report__<groupId>.html.",
      "",
      "  impact --repo-id <id> [--config <path>] [--no-persist]",
      "      Compara o grafo atual do grupo contra o snapshot salvo, pro repositório informado.",
      "      --no-persist não recalibra o snapshot salvo (útil pra checagem exploratória repetida).",
      "",
      "  impact-report --repo-id <id> [--config <path>] [--vault <path>]",
      "      Recalcula o impacto (somente leitura) e grava o relatório markdown + anota as notas de",
      "      integração afetadas no vault.",
      "",
      "--config default: <cwd>/.traceability/config.json. --vault default: campo vaultPath do config,",
      "ou o vault compartilhado padrão se nenhum dos dois for informado.",
    ].join("\n"),
  );
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "scan":
        runScan(rest);
        break;
      case "update-graph":
        runUpdateGraph(rest);
        break;
      case "html-report":
        runHtmlReport(rest);
        break;
      case "impact":
        runImpact(rest);
        break;
      case "impact-report":
        runImpactReport(rest);
        break;
      default:
        printUsage();
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
