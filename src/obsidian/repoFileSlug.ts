import crypto from "node:crypto";
import { assertSafeId } from "../config/safeId.js";
import type { GroupRepoConfig } from "../config/groupConfig.js";

/**
 * O Graph View NATIVO do Obsidian (canvas, `Cmd+G`) rotula cada nó com o nome do ARQUIVO por trás
 * dele — diferente dos diagramas Mermaid (nas notas e no relatório HTML), que sempre mostram o
 * `repoId` completo no texto do nó e não sofrem com isso. Não existe configuração de exibição no
 * próprio Obsidian pra truncar/abreviar esse rótulo — a única alavanca real é o nome do arquivo.
 * Este módulo resolve, por repositório, qual nome de arquivo usar pra nota dele — nunca o `repoId`
 * em si, que continua intocado em todo o resto (frontmatter, conteúdo da nota, grafo/cascata,
 * snapshot/diff entre scans).
 */

function shortHash(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 6);
}

/**
 * Resolve o nome de arquivo (sem extensão) de UM repositório, nesta ordem de prioridade:
 *  1. `displayName` explícito no config deste repo — usado como está, sem nenhuma outra lógica
 *     (controle total do usuário; já validado como safe-id em `loadGroupConfig`).
 *  2. Sem `displayName`, e `maxRepoNameLength` configurado no grupo com `repoId` excedendo esse
 *     limite: trunca nesse tamanho e sufixa `-` + um hash curto e estável do `repoId` ORIGINAL
 *     (nunca do truncado) — garante que dois repoIds que só divergem DEPOIS do limite (comum quando
 *     todos os repos de uma empresa compartilham um prefixo longo, ex:
 *     "acme-platform-payments-checkout-service" vs "acme-platform-payments-webhook-service") nunca
 *     colidam no mesmo arquivo, sem precisar de uma segunda passada pra detectar duplicatas entre
 *     os repos do grupo. O separador é `-` (não `~`/outro símbolo) porque o resultado ainda precisa
 *     bater com `SAFE_ID_PATTERN` (`assertSafeId`, reaproveitada aqui) — ele vira nome de arquivo.
 *  3. Nenhum dos dois (ou `repoId` já é curto o bastante): `repoId` sem alteração — comportamento
 *     de sempre, zero mudança pra quem não configurar nada disso.
 */
export function resolveRepoFileSlug(repoId: string, repoConfig: GroupRepoConfig | undefined, maxRepoNameLength: number | undefined): string {
  if (repoConfig?.displayName) return repoConfig.displayName;
  if (maxRepoNameLength !== undefined && maxRepoNameLength > 0 && repoId.length > maxRepoNameLength) {
    return `${repoId.slice(0, maxRepoNameLength)}-${shortHash(repoId)}`;
  }
  return repoId;
}

/**
 * Monta o mapa `repoId -> nome de arquivo` pra TODOS os repositórios de um grupo de uma vez —
 * usado por `obsidianWriter.ts` pra decidir o nome real de cada `Repos/<groupId>/<slug>.md`, e
 * repassado via `GraphRenderContext`/parâmetros explícitos pra `noteTemplates.ts` construir
 * wikilinks que apontam pro arquivo certo (mantendo `repoId` como texto do link, só o CAMINHO muda).
 * Falha cedo (erro claro, citando os dois repoIds em conflito) se dois repositórios acabarem
 * resolvendo pro MESMO nome de arquivo — só pode acontecer com `displayName` explícito colidindo
 * (a truncagem automática por `maxRepoNameLength` nunca colide, por construção do hash acima).
 */
export function buildRepoFileSlugMap(
  repoIds: Iterable<string>,
  repoConfigs: GroupRepoConfig[],
  maxRepoNameLength: number | undefined,
): Map<string, string> {
  const configById = new Map(repoConfigs.map((config) => [config.id, config]));
  const slugToRepoId = new Map<string, string>();
  const result = new Map<string, string>();
  for (const repoId of repoIds) {
    const slug = assertSafeId(
      resolveRepoFileSlug(repoId, configById.get(repoId), maxRepoNameLength),
      `nome de arquivo resolvido para o repositório "${repoId}"`,
    );
    const existingOwner = slugToRepoId.get(slug);
    if (existingOwner !== undefined && existingOwner !== repoId) {
      throw new Error(
        `Conflito de nome de arquivo: os repositórios "${existingOwner}" e "${repoId}" resolveram para o ` +
          `mesmo nome "${slug}". Ajuste "displayName" num dos dois em .traceability/config.json pra desambiguar.`,
      );
    }
    slugToRepoId.set(slug, repoId);
    result.set(repoId, slug);
  }
  return result;
}
