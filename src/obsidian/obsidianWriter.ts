import fs from "node:fs";
import path from "node:path";
import { applyCascadingImpact } from "../graph/cascadeImpact.js";
import type { GraphEdge, GraphSnapshot } from "../graph/types.js";
import type { EdgeDiffEntry, ImpactDiff } from "../impact/diffEngine.js";
import {
  AUTO_GENERATED_END,
  renderGroupNote,
  renderImpactReport,
  renderIntegrationNote,
  renderRepoNote,
  renderServiceNote,
} from "./noteTemplates.js";
import { ensureGraphViewConfig } from "./graphViewConfig.js";
import { buildRenderContext } from "./mermaidRenderer.js";
import { listRemovedEdges, markIntegrationNoteRemoved, reconstructMissingServiceNodes } from "./removedEdgeDetector.js";
import { extractFrontmatterGeneratedAt, writeCurrentAndArchivePrevious } from "./versionedReport.js";

const VAULT_SUBFOLDERS = ["Groups", "Repos", "Services", "Integrations", "Reports"];

export function ensureVaultStructure(vaultPath: string): void {
  for (const dir of VAULT_SUBFOLDERS) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }
  ensureGraphViewConfig(vaultPath);
}

/**
 * Junta o bloco recém-gerado com o conteúdo manual que o usuário tenha adicionado após o marcador
 * AUTO-GENERATED:END em uma execução anterior. Se o marcador não existir ainda (arquivo novo ou
 * criado manualmente sem os marcadores), o arquivo inteiro anterior é preservado como cauda manual.
 */
function mergeWithManualTail(filePath: string, generated: string): string {
  if (!fs.existsSync(filePath)) return `${generated}\n`;
  const existing = fs.readFileSync(filePath, "utf8");
  const endIdx = existing.indexOf(AUTO_GENERATED_END);
  if (endIdx === -1) return `${generated}\n`;
  const manualTail = existing.slice(endIdx + AUTO_GENERATED_END.length);
  return `${generated}${manualTail}`;
}

/** Lê o campo `group:` do frontmatter de uma nota já existente, sem parsear o YAML inteiro (mesmo
 * formato simples que `frontmatter()` em noteTemplates.ts sempre produz: `group: "valor"`). */
function existingNoteGroup(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, "utf8");
  return /^group:\s*"([^"]*)"/m.exec(content)?.[1];
}

/**
 * Achado real em produção: o vault é compartilhado entre TODOS os grupos rastreados (é isso que
 * viabiliza a visão macro em index.md), mas o nome do arquivo de nota de repo/serviço/integração
 * usa só o id (repoId/serviceId/edgeId), sem o groupId — dois grupos independentes que por
 * coincidência usam o mesmo id (ex: dois sistemas diferentes com um repo chamado "order-service")
 * sobrescreviam silenciosamente a nota um do outro, sem aviso nenhum. Antes de gravar, confere se a
 * nota já existe E pertence a um group DIFERENTE do que está gerando agora — se sim, recusa
 * sobrescrever (o valor antigo fica intacto) e devolve `false`, pro chamador acumular um aviso
 * explícito na resposta da tool em vez de corromper dado de outro grupo em silêncio.
 */
function writeMerged(filePath: string, generated: string, expectedGroup: string): boolean {
  const existingGroup = existingNoteGroup(filePath);
  if (existingGroup !== undefined && existingGroup !== expectedGroup) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, mergeWithManualTail(filePath, generated), "utf8");
  return true;
}

export function writeGraphToVault(
  vaultPath: string,
  snapshot: GraphSnapshot,
): { filesWritten: string[]; collisions: string[] } {
  ensureVaultStructure(vaultPath);
  const filesWritten: string[] = [];
  const collisions: string[] = [];

  const write = (filePath: string, generated: string): void => {
    if (writeMerged(filePath, generated, snapshot.group)) {
      filesWritten.push(filePath);
    } else {
      collisions.push(
        `${path.relative(vaultPath, filePath)} pertence a outro grupo — não sobrescrito. Dois grupos ` +
          `diferentes estão usando o mesmo id pra coisas diferentes; renomeie o id num dos dois configs.`,
      );
    }
  };

  // Integrações que existiam no vault (deste grupo) mas não foram detectadas nesta varredura —
  // sem isso, uma integração que some (ex: nome de tópico não bate mais) desaparece em silêncio.
  const currentEdgeIds = new Set(snapshot.edges.map((edge) => edge.id));
  const removedEdges = listRemovedEdges(vaultPath, snapshot.group, currentEdgeIds);
  for (const removedEdge of removedEdges) {
    markIntegrationNoteRemoved(vaultPath, snapshot.group, removedEdge.id, snapshot.generatedAt);
  }
  // Impacto em cascata: qualquer edge ativa a jusante de uma broken/removed também fica "impacted"
  // (vermelho) — o alerta precisa alcançar até onde a mudança realmente se propaga, não só a edge quebrada.
  const allEdges: GraphEdge[] = applyCascadingImpact(
    [...snapshot.edges, ...removedEdges],
    snapshot.repos.map((repo) => repo.repoId),
  );
  // Um recurso de infra pode desaparecer por completo da varredura (ex: bloco removido do
  // Terraform), não só a edge que o toca — sem reconstruir o ServiceNode a partir da nota antiga,
  // `ctx` não sabe mais que esse id é um serviço, e os diagramas (Grupo + ego-graph do repo)
  // param de declarar o hexágono com rótulo amigável para a edge removida que ainda o referencia.
  const currentServiceIds = new Set(snapshot.serviceNodes.map((node) => node.id));
  const missingServiceNodes = reconstructMissingServiceNodes(vaultPath, snapshot.group, currentServiceIds);
  const allServiceNodes = [...snapshot.serviceNodes, ...missingServiceNodes];
  const ctx = buildRenderContext(snapshot.repos, allServiceNodes);

  for (const repo of snapshot.repos) {
    const outgoing = allEdges.filter((edge) => edge.source === repo.repoId);
    const incoming = allEdges.filter((edge) => edge.target === repo.repoId);
    const filePath = path.join(vaultPath, "Repos", snapshot.group, `${repo.repoId}.md`);
    write(filePath, renderRepoNote(repo, snapshot.group, outgoing, incoming, ctx));
  }

  // Sem essa nota, o wikilink pro nó de serviço (usado nas notas de integração onde ele é
  // origem/destino) fica "unresolved" — o Graph View nativo ainda desenha o nó (hideUnresolved:
  // false), mas abre em branco ao clicar, porque não existe arquivo nenhum por trás do link.
  for (const node of allServiceNodes) {
    const filePath = path.join(vaultPath, "Services", snapshot.group, `${node.id}.md`);
    write(
      filePath,
      renderServiceNote(
        node,
        snapshot.group,
        allEdges,
        snapshot.repos.map((repo) => repo.repoId),
      ),
    );
  }

  for (const edge of allEdges.filter((edge) => edge.status !== "removed")) {
    const filePath = path.join(vaultPath, "Integrations", snapshot.group, `${edge.id}.md`);
    write(filePath, renderIntegrationNote(edge, snapshot.group, snapshot.generatedAt));
  }
  for (const removedEdge of removedEdges) {
    filesWritten.push(path.join(vaultPath, "Integrations", snapshot.group, `${removedEdge.id}.md`));
  }

  // A nota de Grupo já é namespaced pelo próprio nome do arquivo (Groups/<groupId>.md) — dois
  // grupos nunca colidem aqui, não precisa do guard.
  const groupFilePath = path.join(vaultPath, "Groups", `${snapshot.group}.md`);
  fs.writeFileSync(
    groupFilePath,
    renderGroupNote(
      snapshot.group,
      snapshot.repos.map((repo) => repo.repoId),
      allEdges,
      ctx,
    ),
    "utf8",
  );
  filesWritten.push(groupFilePath);

  return { filesWritten, collisions };
}

export function writeImpactReport(vaultPath: string, diff: ImpactDiff): string {
  ensureVaultStructure(vaultPath);
  return writeCurrentAndArchivePrevious(
    path.join(vaultPath, "Reports"),
    `impact-report__${diff.repoId}`,
    ".md",
    renderImpactReport(diff),
    extractFrontmatterGeneratedAt,
  );
}

function describeChange(change: EdgeDiffEntry): string {
  if (change.status === "modified") {
    return `versão alterada de \`${change.previousVersion ?? "?"}\` para \`${change.currentVersion ?? "?"}\``;
  }
  if (change.status === "added") {
    return `integração detectada pela primeira vez (versão ${change.currentVersion ?? "n/a"})`;
  }
  if (change.status === "removed") {
    return `integração não detectada mais (última versão conhecida: ${change.previousVersion ?? "n/a"})`;
  }
  return "sem alteração";
}

/**
 * Anexa uma linha de histórico na nota de integração, sempre após o marcador AUTO-GENERATED:END,
 * para sobreviver a futuras regravações de writeGraphToVault (que só regenera o que está antes do END).
 */
function annotateIntegrationNote(vaultPath: string, groupId: string, edgeId: string, historyLine: string): boolean {
  const filePath = path.join(vaultPath, "Integrations", groupId, `${edgeId}.md`);
  if (!fs.existsSync(filePath)) return false;

  const content = fs.readFileSync(filePath, "utf8");
  const historyHeading = "## Histórico de impacto";
  const updated = content.includes(historyHeading)
    ? content.replace(historyHeading, `${historyHeading}\n${historyLine}`)
    : `${content.trimEnd()}\n\n${historyHeading}\n${historyLine}\n`;

  fs.writeFileSync(filePath, updated, "utf8");
  return true;
}

/** Anota (na cauda manual, preservada entre regravações) todas as notas de integração afetadas pelo diff. */
export function annotateAffectedNotes(vaultPath: string, diff: ImpactDiff): string[] {
  const updated: string[] = [];
  for (const change of diff.changes) {
    const historyLine = `- ${diff.generatedAt}: ${describeChange(change)}`;
    if (annotateIntegrationNote(vaultPath, diff.group, change.edgeId, historyLine)) {
      updated.push(path.join(vaultPath, "Integrations", diff.group, `${change.edgeId}.md`));
    }
  }
  return updated;
}
