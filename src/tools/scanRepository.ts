import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeRepository } from "../adapters/adapterRegistry.js";
import { writeManifest } from "../config/manifest.js";

export function registerScanRepositoryTool(server: McpServer): void {
  server.registerTool(
    "scan_repository",
    {
      title: "Scan Repository",
      description:
        "Analisa um único repositório (por linguagem/build system) e retorna os sinais de integração detectados " +
        "(dependências de artefato publicado, chamadas HTTP de saída, filas, contratos de API/schema). " +
        "Não resolve integrações entre repositórios — isso é feito por map_integrations. Com writeManifest=true, " +
        "também grava um manifesto (.traceability/manifest.json por padrão) que outro grupo, rodando em outro " +
        "diretório/máquina, pode referenciar via manifestPath/manifestsDir no seu config.json — permite rastrear " +
        "este repositório sem ele precisar conhecer os irmãos.",
      inputSchema: {
        repoPath: z.string().describe("Caminho absoluto do repositório a ser analisado"),
        repoId: z
          .string()
          .optional()
          .describe("Identificador lógico do repositório (default: nome da pasta em repoPath)"),
        writeManifest: z
          .boolean()
          .optional()
          .describe("Se true, grava o manifesto do repositório em disco além de retornar o resultado"),
        manifestPath: z
          .string()
          .optional()
          .describe("Caminho do manifesto a gravar (default: <repoPath>/.traceability/manifest.json). Só usado se writeManifest=true."),
      },
    },
    async ({ repoPath, repoId, writeManifest: shouldWriteManifest, manifestPath }) => {
      const resolvedRepoId = repoId ?? path.basename(repoPath);
      if (shouldWriteManifest) {
        const manifest = writeManifest(repoPath, resolvedRepoId, manifestPath);
        return {
          content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }],
        };
      }
      const result = analyzeRepository(repoPath, resolvedRepoId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
