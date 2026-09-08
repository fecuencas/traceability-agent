import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadGroupConfig } from "../config/groupConfig.js";
import { DEFAULT_VAULT_PATH } from "../config/vaultConfig.js";
import { runImpactCheck } from "../impact/impactCheck.js";
import type { ImpactDiff } from "../impact/diffEngine.js";
import { annotateAffectedNotes, writeImpactReport } from "../obsidian/obsidianWriter.js";

/** Recalcula o diff sem persistir snapshot novo — usado só quando o chamador não passou um diff pronto. */
function computeReadOnlyDiff(configPath: string | undefined, repoId: string): ImpactDiff {
  return runImpactCheck({ configPath, repoId, persist: false });
}

function isImpactDiffShape(value: unknown): value is ImpactDiff {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.changes) && Array.isArray(candidate.blastRadius) && typeof candidate.repoId === "string";
}

/**
 * Alguns clientes MCP repassam o texto bruto (JSON.stringify) do retorno de analyze_impact em vez de
 * um objeto — aceita os dois formatos em vez de falhar silenciosamente com um erro de tipo confuso.
 */
function coerceDiff(diff: unknown): ImpactDiff | undefined {
  if (diff === undefined || diff === null) return undefined;
  if (typeof diff === "string") {
    try {
      const parsed = JSON.parse(diff);
      return isImpactDiffShape(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isImpactDiffShape(diff) ? diff : undefined;
}

export function registerGenerateImpactReportTool(server: McpServer): void {
  server.registerTool(
    "generate_impact_report",
    {
      title: "Generate Impact Report",
      description:
        "Grava um relatório markdown em Reports/ a partir de um ImpactDiff (idealmente o retorno de " +
        "analyze_impact) e anota as notas de integração afetadas com uma linha de histórico. Se `diff` for " +
        "omitido, recalcula um diff somente-leitura (sem persistir novo snapshot) comparando o estado atual " +
        "dos repositórios (configurados em .traceability/config.json) contra o snapshot salvo.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Caminho do .traceability/config.json (default: <cwd>/.traceability/config.json)"),
        repoId: z.string().describe("Repositório cujo impacto está sendo reportado"),
        diff: z
          .unknown()
          .optional()
          .describe(
            "ImpactDiff previamente calculado por analyze_impact (objeto ou a mesma string JSON retornada por " +
              "ele — os dois formatos são aceitos). Se omitido ou em formato inesperado, recalcula sozinho.",
          ),
        vaultPath: z
          .string()
          .optional()
          .describe(
            `Caminho do vault Obsidian. Se omitido: usa o campo "vaultPath" do .traceability/config.json, ` +
              `se presente; senão usa o vault compartilhado padrão (${DEFAULT_VAULT_PATH}).`,
          ),
      },
    },
    async ({ configPath, repoId, diff, vaultPath }) => {
      const resolvedDiff = coerceDiff(diff) ?? computeReadOnlyDiff(configPath, repoId);
      const resolvedVaultPath = vaultPath ?? loadGroupConfig(configPath).vaultPath ?? DEFAULT_VAULT_PATH;

      const reportPath = writeImpactReport(resolvedVaultPath, resolvedDiff);
      const notesUpdated = annotateAffectedNotes(resolvedVaultPath, resolvedDiff);

      return {
        content: [{ type: "text", text: JSON.stringify({ reportPath, notesUpdated }, null, 2) }],
      };
    },
  );
}
