import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeGroup } from "../config/groupAnalysis.js";
import { DEFAULT_VAULT_PATH } from "../config/vaultConfig.js";
import { applyCascadingImpact } from "../graph/cascadeImpact.js";
import { loadRenderBaseline, saveRenderBaseline } from "../graph/graphSnapshot.js";
import { flagContractSchemaWarnings } from "../graph/contractSchemaWarnings.js";
import { flagVersionWarnings } from "../graph/versionWarnings.js";
import { listRemovedEdges, reconstructMissingServiceNodes } from "../obsidian/removedEdgeDetector.js";
import { extractHtmlGeneratedAt, writeCurrentAndArchivePrevious } from "../obsidian/versionedReport.js";
import { renderHtmlReport } from "../reports/htmlReport.js";

export function registerGenerateHtmlReportTool(server: McpServer): void {
  server.registerTool(
    "generate_html_report",
    {
      title: "Generate HTML Report",
      description:
        "Gera um relatório HTML autocontido (sem dependências externas) do grupo: resumo, grafo visual das " +
        "integrações, tabela completa e uma seção de problemas com as integrações corrompidas destacadas. " +
        "Grava sempre em Reports/html-report__<groupId>.html (nome fixo = versão atual); se já existir um " +
        "relatório anterior, ele é arquivado antes com a data/hora da própria geração dele.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Caminho do .traceability/config.json (default: <cwd>/.traceability/config.json)"),
        vaultPath: z
          .string()
          .optional()
          .describe(
            `Caminho do vault Obsidian. Se omitido: usa o campo "vaultPath" do .traceability/config.json, ` +
              `se presente; senão usa o vault compartilhado padrão (${DEFAULT_VAULT_PATH}).`,
          ),
      },
    },
    async ({ configPath, vaultPath }) => {
      const { config, snapshot } = analyzeGroup(configPath);
      const resolvedVaultPath = vaultPath ?? config.vaultPath ?? DEFAULT_VAULT_PATH;

      const previousBaseline = loadRenderBaseline(config.configPath);
      snapshot.edges = flagVersionWarnings(snapshot.edges, previousBaseline);
      snapshot.edges = flagContractSchemaWarnings(snapshot.edges, previousBaseline);
      saveRenderBaseline(config.configPath, snapshot);

      // inclui integrações que existem no vault mas não foram detectadas nesta varredura (removidas),
      // para o relatório mostrar o mesmo alerta que as notas do Obsidian já mostram
      const currentEdgeIds = new Set(snapshot.edges.map((edge) => edge.id));
      const removedEdges = listRemovedEdges(resolvedVaultPath, config.groupId, currentEdgeIds);
      snapshot.edges = applyCascadingImpact(
        [...snapshot.edges, ...removedEdges],
        snapshot.repos.map((repo) => repo.repoId),
      );
      // Mesmo caso do writeGraphToVault: um recurso de infra pode sumir por completo da varredura
      // (não só a edge) — sem reconstruir o ServiceNode a partir da nota antiga, o relatório perde
      // o hexágono/rótulo amigável desse nó assim que uma edge removida ainda o referencia.
      const currentServiceIds = new Set(snapshot.serviceNodes.map((node) => node.id));
      const missingServiceNodes = reconstructMissingServiceNodes(resolvedVaultPath, config.groupId, currentServiceIds);
      snapshot.serviceNodes = [...snapshot.serviceNodes, ...missingServiceNodes];

      const html = renderHtmlReport(snapshot);
      const reportsDir = path.join(resolvedVaultPath, "Reports");
      const reportPath = writeCurrentAndArchivePrevious(
        reportsDir,
        `html-report__${config.groupId}`,
        ".html",
        html,
        extractHtmlGeneratedAt,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                reportPath,
                repos: snapshot.repos.length,
                serviceNodes: snapshot.serviceNodes.length,
                integrations: snapshot.edges.length,
                broken: snapshot.edges.filter((edge) => edge.status === "broken").length,
                impacted: snapshot.edges.filter((edge) => edge.status === "impacted").length,
                removed: snapshot.edges.filter((edge) => edge.status === "removed").length,
                warnings: snapshot.edges.filter((edge) => edge.versionWarning).length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
