import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeGroup } from "../config/groupAnalysis.js";
import { recordGroupInRegistry } from "../config/groupConfig.js";
import { DEFAULT_VAULT_PATH } from "../config/vaultConfig.js";
import { loadRenderBaseline, saveRenderBaseline } from "../graph/graphSnapshot.js";
import { flagContractSchemaWarnings } from "../graph/contractSchemaWarnings.js";
import { flagVersionWarnings } from "../graph/versionWarnings.js";
import { writeGraphToVault } from "../obsidian/obsidianWriter.js";
import { writeOverviewToVault } from "../obsidian/overviewWriter.js";

export interface UpdateObsidianGraphOptions {
  configPath?: string;
  vaultPath?: string;
}

export interface UpdateObsidianGraphResult {
  vaultPath: string;
  filesWritten: string[];
  collisions: string[];
}

/**
 * Núcleo de "escanear o grupo e gravar o vault" — reaproveitado pela tool MCP `update_obsidian_graph`
 * e pelo subcomando `update-graph` do CLI standalone (`src/cli/index.ts`), pra não duplicar essa
 * lógica entre as duas superfícies (a MCP pra outras IAs falarem com o agente, o CLI pra uso local
 * direto no terminal, sem cliente MCP nenhum).
 */
export function runUpdateObsidianGraph(options: UpdateObsidianGraphOptions): UpdateObsidianGraphResult {
  const { config, snapshot } = analyzeGroup(options.configPath);
  const previousBaseline = loadRenderBaseline(config.configPath);
  snapshot.edges = flagVersionWarnings(snapshot.edges, previousBaseline);
  snapshot.edges = flagContractSchemaWarnings(snapshot.edges, previousBaseline);
  const resolvedVaultPath = options.vaultPath ?? config.vaultPath ?? DEFAULT_VAULT_PATH;
  const result = writeGraphToVault(resolvedVaultPath, snapshot);
  saveRenderBaseline(config.configPath, snapshot);
  recordGroupInRegistry(config.groupId, config.configPath, snapshot.generatedAt);
  const overview = writeOverviewToVault(resolvedVaultPath);
  return {
    vaultPath: resolvedVaultPath,
    filesWritten: [...result.filesWritten, overview.filePath],
    collisions: result.collisions,
  };
}

export function registerUpdateObsidianGraphTool(server: McpServer): void {
  server.registerTool(
    "update_obsidian_graph",
    {
      title: "Update Obsidian Graph",
      description:
        "Escaneia os repositórios configurados em .traceability/config.json (do diretório atual, ou de " +
        "configPath se informado), resolve as integrações entre eles e grava/atualiza as notas correspondentes " +
        "no vault do Obsidian (uma nota por repositório, uma por integração, uma por grupo, mais a visão macro " +
        "em index.md). Preserva qualquer conteúdo manual adicionado após o marcador AUTO-GENERATED:END em " +
        "execuções anteriores. Por padrão o vault é COMPARTILHADO entre todos os grupos rastreados na " +
        "máquina (é isso que viabiliza a visão macro em index.md) — se um id (repo/serviço/integração) deste " +
        "grupo colidir com um id já usado por OUTRO grupo nesse vault compartilhado, a nota não é " +
        "sobrescrita (evita corromper o outro grupo em silêncio) e a colisão aparece em `collisions` na " +
        "resposta; avise o usuário e sugira renomear o id num dos dois configs, OU dar um vault próprio a um " +
        "dos grupos (campo `vaultPath` no `.traceability/config.json`) pra nunca mais colidir.",
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
      const result = runUpdateObsidianGraph({ configPath, vaultPath });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                vaultPath: result.vaultPath,
                filesWritten: result.filesWritten,
                ...(result.collisions.length > 0 ? { collisions: result.collisions } : {}),
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
