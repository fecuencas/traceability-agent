import fs from "node:fs";
import path from "node:path";
import type { Confidence, IntegrationSignalType, ServiceType } from "../adapters/types.js";
import type { GraphEdge, ServiceNode } from "../graph/types.js";

/** Faz parse do frontmatter YAML-simplificado que noteTemplates.ts gera (uma chave: valor-JSON por linha). */
function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return undefined;
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const sepIndex = line.indexOf(": ");
    if (sepIndex === -1) continue;
    const key = line.slice(0, sepIndex);
    const rawValue = line.slice(sepIndex + 2);
    try {
      fields[key] = JSON.parse(rawValue);
    } catch {
      fields[key] = rawValue;
    }
  }
  return fields;
}

/**
 * Reconstrói, a partir das notas de integração já existentes no vault (para o `groupId` informado),
 * quais integrações eram conhecidas antes mas não aparecem no `currentEdgeIds` da varredura atual —
 * ou seja, integrações que sumiram (ex: nome de tópico não bate mais, dependência removida do pom).
 * Sem isso, uma integração que deixa de ser detectada simplesmente desaparece do grafo em silêncio.
 * Retorna TODAS as removidas (recém-detectadas ou já marcadas antes) — usado tanto para marcar as
 * notas quanto para desenhar essas edges (cinza tracejado) nos diagramas; `markIntegrationNoteRemoved`
 * é idempotente, então chamar de novo para uma já marcada não duplica nada.
 */
export function listRemovedEdges(vaultPath: string, groupId: string, currentEdgeIds: Set<string>): GraphEdge[] {
  const integrationsDir = path.join(vaultPath, "Integrations", groupId);
  if (!fs.existsSync(integrationsDir)) return [];

  const removed: GraphEdge[] = [];
  for (const fileName of fs.readdirSync(integrationsDir)) {
    if (!fileName.endsWith(".md")) continue;
    const edgeId = fileName.slice(0, -3);
    if (currentEdgeIds.has(edgeId)) continue;

    const filePath = path.join(integrationsDir, fileName);
    const fields = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    if (!fields) continue;
    // A subpasta já garante que só notas DESTE grupo estão aqui (Integrations/<groupId>/) — a
    // checagem abaixo é só uma segunda camada de defesa (notas antigas de antes do namespacing por
    // pasta, ou algum arquivo colocado manualmente na pasta errada).
    const belongsToGroup = fields.group === groupId || (Array.isArray(fields.tags) && fields.tags.includes(groupId));
    if (!belongsToGroup) continue;

    removed.push({
      id: edgeId,
      source: String(fields.source ?? ""),
      target: String(fields.target ?? ""),
      type: fields.integrationType as IntegrationSignalType,
      version: typeof fields.version === "string" ? fields.version : undefined,
      confidence: (fields.confidence as Confidence) ?? "low",
      detectorId: String(fields.detectorId ?? "unknown"),
      evidence: {
        file: String(fields.evidenceFile ?? "desconhecido"),
        line: typeof fields.evidenceLine === "number" ? fields.evidenceLine : undefined,
        snippet: "",
      },
      status: "removed",
    });
  }
  return removed;
}

/**
 * Reconstrói, a partir das notas de serviço já existentes no vault, os `ServiceNode` que não
 * aparecem mais na varredura atual (ex: recurso removido do Terraform/serverless.yml) — sem isso,
 * o nó continua sendo referenciado por uma edge removida reconstruída (`listRemovedEdges`), mas o
 * `GraphRenderContext` não sabe mais que esse id é um serviço: os diagramas (grafo do Grupo e
 * ego-graph do repositório) param de declarar o hexágono com rótulo amigável e caem no fallback de
 * "trata como repositório", produzindo um nó retangular sem forma/tipo, só com o id cru como texto.
 * A evidência não é reconstruída (só existe no corpo da nota, não no frontmatter) — mesma perda de
 * fidelidade, por design, que já acontece com o `snippet` de uma edge removida em `listRemovedEdges`.
 */
export function reconstructMissingServiceNodes(
  vaultPath: string,
  groupId: string,
  currentServiceIds: Set<string>,
): ServiceNode[] {
  const servicesDir = path.join(vaultPath, "Services", groupId);
  if (!fs.existsSync(servicesDir)) return [];

  const reconstructed: ServiceNode[] = [];
  for (const fileName of fs.readdirSync(servicesDir)) {
    if (!fileName.endsWith(".md")) continue;
    const serviceId = fileName.slice(0, -3);
    if (currentServiceIds.has(serviceId)) continue;

    const filePath = path.join(servicesDir, fileName);
    const fields = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    if (!fields) continue;
    // Mesma segunda camada de defesa de listRemovedEdges — a subpasta já garante o grupo.
    const belongsToGroup = fields.group === groupId || (Array.isArray(fields.tags) && fields.tags.includes(groupId));
    if (!belongsToGroup) continue;

    reconstructed.push({
      id: serviceId,
      serviceType: fields.serviceType as ServiceType,
      label: String(fields.label ?? serviceId),
      evidence: [],
    });
  }
  return reconstructed;
}

/**
 * Marca a nota de integração antiga como removida: atualiza `status`/tags no frontmatter e insere um
 * banner logo após o título, sem tocar no restante do corpo (evidência antiga fica como histórico).
 */
export function markIntegrationNoteRemoved(vaultPath: string, groupId: string, edgeId: string, detectedAt: string): void {
  const filePath = path.join(vaultPath, "Integrations", groupId, `${edgeId}.md`);
  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes('status: "removed"')) return; // já marcada

  content = content.replace(/^status: ".*"$/m, 'status: "removed"');
  content = content.replace(/^tags: (\[[^\]]*\])$/m, (full, arrLiteral: string) => {
    try {
      const tags = JSON.parse(arrLiteral) as string[];
      if (!tags.includes("removed")) tags.push("removed");
      return `tags: ${JSON.stringify(tags)}`;
    } catch {
      return full;
    }
  });

  const banner = `\n> 🗑️ **Integração não detectada na varredura mais recente (${detectedAt}).** Pode ter sido removida de verdade, ou o nome do tópico/endpoint/dependência pode ter mudado de um lado só — confira os dois repositórios envolvidos.\n`;
  if (!content.includes("🗑️")) {
    content = content.replace(/^(# .+\n)/m, `$1${banner}`);
  }

  const historyHeading = "## Histórico de impacto";
  const historyLine = `- ${detectedAt}: integração não detectada mais nesta varredura (marcada como removida)`;
  content = content.includes(historyHeading)
    ? content.replace(historyHeading, `${historyHeading}\n${historyLine}`)
    : `${content.trimEnd()}\n\n${historyHeading}\n${historyLine}\n`;

  fs.writeFileSync(filePath, content, "utf8");
}
