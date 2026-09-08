#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerScanRepositoryTool } from "./tools/scanRepository.js";
import { registerMapIntegrationsTool } from "./tools/mapIntegrations.js";
import { registerUpdateObsidianGraphTool } from "./tools/updateObsidianGraph.js";
import { registerAnalyzeImpactTool } from "./tools/analyzeImpact.js";
import { registerGenerateImpactReportTool } from "./tools/generateImpactReport.js";
import { registerGenerateRegressionTestsTool } from "./tools/generateRegressionTests.js";
import { registerGenerateHtmlReportTool } from "./tools/generateHtmlReport.js";
import { registerGenerateOverviewGraphTool } from "./tools/generateOverviewGraph.js";

const server = new McpServer({
  name: "traceability-agent",
  version: "0.1.0",
});

registerScanRepositoryTool(server);
registerMapIntegrationsTool(server);
registerUpdateObsidianGraphTool(server);
registerAnalyzeImpactTool(server);
registerGenerateImpactReportTool(server);
registerGenerateRegressionTestsTool(server);
registerGenerateHtmlReportTool(server);
registerGenerateOverviewGraphTool(server);

server.registerTool(
  "ping",
  {
    title: "Ping",
    description:
      "Tool de diagnóstico para validar o handshake do MCP server. Retorna 'pong' e o timestamp recebido do chamador.",
    inputSchema: {
      message: z.string().optional().describe("Mensagem opcional a ser ecoada de volta"),
    },
  },
  async ({ message }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "pong", echoedMessage: message ?? null }),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Falha ao iniciar traceability-agent MCP server:", error);
  process.exit(1);
});
