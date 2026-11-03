import type { IntegrationSignalType, RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "./types.js";

/** Ids dos repositórios cujo `LocalFinding` diz que o repositório inteiro não sobe
 * (`blocksStartup: true` — ver `adapters/types.ts`) — a lista que alimenta tanto `brokenRepoIds` de
 * `applyCascadingImpact` abaixo quanto o mesmo parâmetro em `nodeSeverity.ts`/`mermaidRenderer.ts`.
 * Centralizado aqui (em vez de cada chamador repetir o `.filter().some()`) porque os 4 lugares que
 * chamam `applyCascadingImpact` (`generateHtmlReport.ts`, `obsidianWriter.ts`, `overviewWriter.ts`,
 * `impact/diffEngine.ts`) precisam exatamente da mesma lista. */
export function brokenStartupRepoIds(repos: RepoAnalysisResult[]): string[] {
  return repos.filter((repo) => (repo.localFindings ?? []).some((finding) => finding.blocksStartup)).map((repo) => repo.repoId);
}

/**
 * Tipos de integração cuja semântica é "a origem DEPENDE do alvo" (artefato publicado, chamada
 * HTTP, contrato compartilhado, endpoint configurado). Para esses, o risco se propaga na direção
 * CONTRÁRIA à seta: se o alvo está quebrado/impactado, quem depende dele (a origem) herda o risco,
 * e dali em diante quem depende da origem, e assim por diante. Sem essa distinção, uma dependência
 * de artefato saudável que aponta para um serviço já quebrado por outro motivo (ex: uma fila caiu)
 * nunca era sinalizada — o cascateamento só seguia o sentido da seta (fonte -> alvo), que é o
 * sentido certo para fluxo de dados (fila/evento), mas o sentido ERRADO para dependência.
 */
export const DEPENDENCY_EDGE_TYPES: ReadonlySet<IntegrationSignalType> = new Set([
  "published_artifact_dependency",
  "outbound_http",
  "contract_reference",
  "config_endpoint",
]);

export function isDependencyEdge(edge: GraphEdge): boolean {
  return DEPENDENCY_EDGE_TYPES.has(edge.type);
}

/**
 * Quando uma integração quebra ou desaparece, o impacto se propaga a partir de quem sofre o efeito
 * direto dessa quebra:
 *  - edges de fluxo de dados/posse (fila, consumo, "owns"): quem sofre é o ALVO (a jusante, seguindo
 *    a seta) — ex: fila parou de ser publicada, o consumidor fica sem dado.
 *  - edges de dependência (artefato, HTTP, contrato, config): quem sofre é a ORIGEM (a própria
 *    integração quebrada já significa que quem depende do alvo está com problema).
 * A partir de cada nó afetado, a cascata continua se espalhando usando a MESMA regra por tipo de
 * edge — inclusive alcançando, agora, uma edge de dependência ativa cujo alvo é um nó já em risco
 * (o caso que antes ficava sem nenhum sinal visual).
 *
 * `repoIds` identifica quais nós são repositórios (em oposição a nós de serviço de infra, que
 * multiplexam várias relações independentes — ex: uma fila com 2 consumidores). O outro extremo de
 * toda edge quebrada/removida (o que NÃO foi escolhido como origem principal pela regra acima) só
 * também vira origem quando é um repositório: um repositório que quebrou como ORIGEM de uma fila
 * (ex: parou de publicar) continua sendo, ele mesmo, um repo quebrado — e por isso precisa também
 * propagar pra trás pra quem depende do seu artefato (sem essa checagem extra, só o nó de serviço
 * herdava o papel de origem, e o repo nunca disparava a cascata de dependência que o atinge). Um nó
 * de serviço nessa mesma posição NÃO vira origem adicional: a fila em si não está "quebrada" só
 * porque um consumidor específico parou de funcionar — os outros consumidores dela continuam OK.
 *
 * `brokenRepoIds` cobre o caso de um repositório estar quebrado sem NENHUMA edge dizendo isso — hoje
 * só um `LocalFinding` com `blocksStartup: true` (ex: classe principal do Spring Boot sem
 * `@SpringBootApplication` — o serviço inteiro nunca sobe) alimenta isso. Entram na mesma pilha de
 * `origins` que a promoção de "outro extremo" acima já usa, então herdam exatamente a mesma
 * propagação: pra frente via edges de fluxo (o serviço que nunca sobe não publica nada), pra trás
 * via edges de dependência (quem chama esse serviço HTTP sofre) — sem precisar duplicar a lógica de
 * BFS abaixo.
 */
export function applyCascadingImpact(
  edges: GraphEdge[],
  repoIds: Iterable<string> = [],
  brokenRepoIds: Iterable<string> = [],
): GraphEdge[] {
  const repoIdSet = new Set(repoIds);
  const outgoingByRepo = new Map<string, GraphEdge[]>();
  const incomingByRepo = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const outList = outgoingByRepo.get(edge.source) ?? [];
    outList.push(edge);
    outgoingByRepo.set(edge.source, outList);

    const inList = incomingByRepo.get(edge.target) ?? [];
    inList.push(edge);
    incomingByRepo.set(edge.target, inList);
  }

  const impactedIds = new Set<string>();
  const roots = edges.filter((edge) => edge.status === "broken" || edge.status === "removed");

  const origins = new Set<string>();
  for (const root of roots) {
    const primary = isDependencyEdge(root) ? root.source : root.target;
    origins.add(primary);
    // A promoção do outro extremo a origem só faz sentido quando a raiz é uma edge de FLUXO
    // (publish/consume/declaration): aí o outro extremo é o próprio repositório que parou de
    // publicar/declarar, o que É, por si só, evidência de que ele está com problema — daí ele
    // também precisa disparar a cascata pelas SUAS PRÓPRIAS dependências (Achado #2 original).
    // Para uma raiz de DEPENDÊNCIA (artefato/HTTP/contrato/config), o outro extremo é o alvo de
    // quem depende dele — um cliente perder a integração com um alvo não é evidência de que esse
    // alvo esteja quebrado (ex: só o cliente ficou com uma URL desatualizada); promovê-lo a
    // origem faria a cascata vazar, sem motivo real, pelo restante das integrações saudáveis
    // desse alvo (visto no Cenário 4: um cliente HTTP com URL errada para order-service não pode
    // marcar como impactado tudo que depende do Kafka do order-service).
    if (!isDependencyEdge(root)) {
      const secondary = root.source;
      if (repoIdSet.has(secondary)) origins.add(secondary);
    }
  }
  for (const brokenRepoId of brokenRepoIds) origins.add(brokenRepoId);

  const visited = new Set<string>(origins);
  const queue: string[] = Array.from(origins);
  while (queue.length > 0) {
    const repoId = queue.shift() as string;

    for (const edge of outgoingByRepo.get(repoId) ?? []) {
      if (isDependencyEdge(edge) || edge.status !== "active") continue;
      impactedIds.add(edge.id);
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }

    for (const edge of incomingByRepo.get(repoId) ?? []) {
      if (!isDependencyEdge(edge) || edge.status !== "active") continue;
      impactedIds.add(edge.id);
      if (!visited.has(edge.source)) {
        visited.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  if (impactedIds.size === 0) return edges;

  return edges.map((edge) =>
    impactedIds.has(edge.id)
      ? {
          ...edge,
          status: "impacted" as const,
          brokenReason:
            edge.brokenReason ??
            (isDependencyEdge(edge)
              ? "Impacto em cascata: depende de um serviço que está corrompido ou impactado por outra integração."
              : "Impacto em cascata: depende, a montante, de uma integração corrompida ou removida."),
        }
      : edge,
  );
}
