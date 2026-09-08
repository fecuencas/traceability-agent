import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeGroup } from "../config/groupAnalysis.js";
import { generateTestForEdge } from "../testgen/testGeneratorRegistry.js";
import type { GeneratedTest } from "../testgen/types.js";

export function registerGenerateRegressionTestsTool(server: McpServer): void {
  server.registerTool(
    "generate_regression_tests",
    {
      title: "Generate Regression Tests",
      description:
        "Gera (e grava diretamente na árvore de testes do repositório de origem) testes de regressão para as " +
        "integrações do tipo 'published_artifact_dependency' de um grupo. Para cada integração, detecta as " +
        "classes do repositório-alvo importadas no código-fonte do repositório de origem e gera um smoke-test " +
        "JUnit 5 (Java ou Kotlin, conforme a linguagem-fonte real detectada no repo) que falha se alguma dessas " +
        "classes deixar de existir após uma mudança na dependência. Use após analyze_impact para cobrir com " +
        "testes as integrações afetadas por uma alteração.",
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe("Caminho do .traceability/config.json (default: <cwd>/.traceability/config.json)"),
        repoId: z
          .string()
          .optional()
          .describe("Se informado, gera testes só para integrações cujo repositório de ORIGEM seja este"),
        edgeId: z
          .string()
          .optional()
          .describe("Se informado, gera o teste só para esta integração específica (id da edge)"),
      },
    },
    async ({ configPath, repoId, edgeId }) => {
      const { repos, snapshot } = analyzeGroup(configPath);
      const reposById = new Map(repos.map((repo) => [repo.repoId, repo]));

      let edges = snapshot.edges;
      if (repoId) edges = edges.filter((edge) => edge.source === repoId);
      if (edgeId) edges = edges.filter((edge) => edge.id === edgeId);

      const generated: GeneratedTest[] = [];
      const skipped: { edgeId: string; reason: string }[] = [];

      for (const edge of edges) {
        const sourceRepo = reposById.get(edge.source);
        if (!sourceRepo) continue;
        const targetRepo = reposById.get(edge.target);
        const result = generateTestForEdge(sourceRepo, targetRepo, edge, repos);
        if (result) {
          generated.push(result);
        } else if (!fs.existsSync(sourceRepo.repoPath)) {
          skipped.push({
            edgeId: edge.id,
            reason: `Código-fonte de "${sourceRepo.repoId}" não está disponível localmente (repo resolvido via manifesto?) — geração de teste requer checkout local.`,
          });
        } else {
          skipped.push({
            edgeId: edge.id,
            reason: `Tipo de integração '${edge.type}' ainda não suportado pela geração automática de testes.`,
          });
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ generated, skipped }, null, 2) }],
      };
    },
  );
}
