import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_VAULT_PATH } from "../config/vaultConfig.js";
import { writeOverviewToVault } from "../obsidian/overviewWriter.js";

export function registerGenerateOverviewGraphTool(server: McpServer): void {
  server.registerTool(
    "generate_overview_graph",
    {
      title: "Generate Overview Graph",
      description:
        "Escaneia TODOS os grupos/aplicações configurados (groups/*.json) e regenera o index.md (MOC) do " +
        "vault com a visão macro: um diagrama único agrupando os repositórios de cada aplicação numa caixa " +
        "nomeada pelo grupo/repositório principal. Não precisa ser chamada manualmente na maioria dos casos — " +
        "update_obsidian_graph já a executa automaticamente ao final.",
      inputSchema: {
        vaultPath: z
          .string()
          .optional()
          .describe(`Caminho do vault Obsidian (default: ${DEFAULT_VAULT_PATH})`),
      },
    },
    async ({ vaultPath }) => {
      const resolvedVaultPath = vaultPath ?? DEFAULT_VAULT_PATH;
      const result = writeOverviewToVault(resolvedVaultPath);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { filePath: result.filePath, groups: result.groups.map((g) => g.groupId) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
