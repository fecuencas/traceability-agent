import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runImpactCheck } from "../impact/impactCheck.js";

export function registerAnalyzeImpactTool(server: McpServer): void {
  server.registerTool(
    "analyze_impact",
    {
      title: "Analyze Impact",
      description:
        "Reescaneia todos os repositórios configurados em .traceability/config.json (do diretório atual, ou de " +
        "configPath se informado), compara o grafo resultante contra o snapshot salvo anteriormente e retorna " +
        "o diff de integrações (added/removed/modified) relevante ao repoId informado, além do blast radius " +
        "(repos direta ou indiretamente conectados). Persiste o novo snapshot como estado atual em " +
        ".traceability/state/, movendo o anterior para .traceability/state/history/.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Caminho do .traceability/config.json (default: <cwd>/.traceability/config.json)"),
        repoId: z.string().describe("Repositório que foi alterado e cujo impacto deve ser analisado"),
      },
    },
    async ({ configPath, repoId }) => {
      const diff = runImpactCheck({ configPath, repoId, persist: true });
      return {
        content: [{ type: "text", text: JSON.stringify(diff, null, 2) }],
      };
    },
  );
}
