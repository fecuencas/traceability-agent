import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeGroup } from "../config/groupAnalysis.js";

export function registerMapIntegrationsTool(server: McpServer): void {
  server.registerTool(
    "map_integrations",
    {
      title: "Map Integrations",
      description:
        "Escaneia todos os repositórios configurados em .traceability/config.json (do diretório atual, ou de " +
        "configPath se informado) e resolve as integrações entre eles, retornando o grafo consolidado (repos + edges).",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Caminho do .traceability/config.json (default: <cwd>/.traceability/config.json)"),
      },
    },
    async ({ configPath }) => {
      const { snapshot } = analyzeGroup(configPath);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      };
    },
  );
}
