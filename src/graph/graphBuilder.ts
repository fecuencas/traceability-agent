import type { IntegrationSignal, RepoAnalysisResult, ServiceType, SignalEvidence } from "../adapters/types.js";
import type { GroupRepoConfig } from "../config/groupConfig.js";
import { EDGE_LABELS } from "./edgeLabels.js";
import { buildContractSchemaFingerprint, checkContractIntegrity } from "./contractIntegrity.js";
import { checkPublishedArtifactIntegrity } from "./integrityChecker.js";
import type { GraphEdge, GraphSnapshot, ServiceNode } from "./types.js";

/** Monta o mapa "groupId:artifactId" (ou packageName) -> repoId a partir das coordinates de cada repo do grupo. */
function buildCoordinateIndex(repos: RepoAnalysisResult[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const repo of repos) {
    const { groupId, artifactId, packageName } = repo.coordinates;
    if (groupId && artifactId) index.set(`${groupId}:${artifactId}`, repo.repoId);
    if (packageName) index.set(packageName, repo.repoId);
  }
  return index;
}

function buildEndpointEntries(repoConfigs: GroupRepoConfig[]): Array<{ repoId: string; endpoint: string }> {
  const entries: Array<{ repoId: string; endpoint: string }> = [];
  for (const config of repoConfigs) {
    for (const endpoint of config.endpoints ?? []) {
      entries.push({ repoId: config.id, endpoint });
    }
  }
  return entries;
}

function resolveUrlToRepoId(url: string, endpointEntries: Array<{ repoId: string; endpoint: string }>): string | undefined {
  return endpointEntries.find((entry) => url.startsWith(entry.endpoint))?.repoId;
}

function contractBasename(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

/** Obsidian recusa `\`, `/` e `:` em nome de nota (mesmo que o filesystem aceite `:` no macOS) —
 * usado para montar o id de nós de serviço, que vira nome de arquivo (`Integrations/<edgeId>.md`)
 * e alvo de wikilink (`[[...]]`). Sem isso, um id como `svc:topic:orders.created` produz um link
 * que o Obsidian não consegue abrir/criar ("File name cannot contain any of the following
 * characters: \ / :"). */
function sanitizeNoteId(value: string): string {
  return value.replace(/[\\/:]/g, "_");
}

function addEdge(
  edges: GraphEdge[],
  seenEdgeIds: Set<string>,
  source: string,
  target: string,
  signal: IntegrationSignal,
  integrity: { broken: boolean; reason?: string; diffDetails?: string[] },
  contractSchemaFingerprint?: Record<string, string>,
): void {
  if (source === target) return;
  const slug = EDGE_LABELS[signal.type].slug;
  const edgeId = `${source}__${slug}__${target}`;
  if (seenEdgeIds.has(edgeId)) return;
  seenEdgeIds.add(edgeId);

  edges.push({
    id: edgeId,
    source,
    target,
    type: signal.type,
    version: signal.version,
    confidence: signal.confidence,
    detectorId: signal.detectorId,
    evidence: signal.evidence,
    status: integrity.broken ? "broken" : "active",
    brokenReason: integrity.reason,
    contractDiffDetails: integrity.diffDetails,
    contractSchemaFingerprint,
  });
}

/**
 * Cria (ou reaproveita, se já existe um com o mesmo id) o nó de serviço de infra que materializa uma
 * fila/tópico/recurso de nuvem no grafo — ex: `svc:topic:orders.created`, `svc:aws-lambda:fulfill-fn`.
 * Deduplica por id: dois repos publicando no mesmo tópico, ou dois arquivos IaC declarando o mesmo
 * recurso, apontam para o MESMO nó (evidências se acumulam, não duplicam o nó). O `serviceType`
 * informado só é usado para exibição (ícone/classe CSS) do primeiro sinal que criou o nó — não faz
 * parte do id, de propósito: um publisher anotado como Kafka e um consumer anotado como SQS para o
 * MESMO nome de tópico (padrão comum de bridge/nomenclatura cross-tecnologia) precisam cair no MESMO
 * nó, senão a integração fica órfã (ver Achado sobre topologia divergida por serviceType).
 */
function getOrCreateServiceNode(
  serviceNodesById: Map<string, ServiceNode>,
  id: string,
  serviceType: ServiceType,
  name: string,
  evidence: SignalEvidence,
): ServiceNode {
  const existing = serviceNodesById.get(id);
  if (existing) {
    existing.evidence.push(evidence);
    return existing;
  }
  const node: ServiceNode = { id, serviceType, label: name, evidence: [evidence] };
  serviceNodesById.set(id, node);
  return node;
}

/**
 * Cruza os sinais de integração de cada repo do grupo para resolver quais viram edges/nós reais do grafo:
 *  - repo_coordinate  -> casa com as `coordinates` de outro repo (dependência de artefato publicado)
 *  - url              -> casa com os `endpoints` configurados de outro repo (chamada HTTP de saída)
 *  - topic_name       -> materializa um NÓ DE SERVIÇO (fila/tópico) e liga publicadores/consumidores
 *                        a ele, em vez de uma aresta direta repo-a-repo — reflete a topologia real
 *                        (a fila existe mesmo que, neste grupo, não haja consumidor conhecido ainda).
 *  - service_resource -> um repo declara (via Terraform/SAM/serverless.yml) que POSSUI um recurso de
 *                        infra (Lambda, fila, DNS, state machine) — vira aresta "owns" para o nó de serviço.
 *  - contract_file    -> casa repos que referenciam um arquivo de contrato com o mesmo nome
 * Sinais sem correspondência ficam sem `resolvedRepoId` e não geram nó/edge falso.
 */
export function buildGraph(groupId: string, repos: RepoAnalysisResult[], repoConfigs: GroupRepoConfig[] = []): GraphSnapshot {
  const coordinateIndex = buildCoordinateIndex(repos);
  const endpointEntries = buildEndpointEntries(repoConfigs);
  const reposById = new Map(repos.map((repo) => [repo.repoId, repo]));
  const edges: GraphEdge[] = [];
  const seenEdgeIds = new Set<string>();
  const serviceNodesById = new Map<string, ServiceNode>();

  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind === "repo_coordinate") {
        const resolvedRepoId = coordinateIndex.get(signal.target.value);
        if (!resolvedRepoId || resolvedRepoId === repo.repoId) continue;
        signal.target.resolvedRepoId = resolvedRepoId;

        const integrity =
          signal.type === "published_artifact_dependency"
            ? checkPublishedArtifactIntegrity(repo, reposById.get(resolvedRepoId), repos)
            : { broken: false };

        addEdge(edges, seenEdgeIds, repo.repoId, resolvedRepoId, signal, integrity);
      } else if (signal.target.kind === "url") {
        const resolvedRepoId = resolveUrlToRepoId(signal.target.value, endpointEntries);
        if (!resolvedRepoId || resolvedRepoId === repo.repoId) continue;
        signal.target.resolvedRepoId = resolvedRepoId;
        addEdge(edges, seenEdgeIds, repo.repoId, resolvedRepoId, signal, { broken: false });
      }
    }
  }

  // queue_publish/queue_consume -> nó de serviço (fila/tópico) mediando a integração, não repo-a-repo direto
  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind !== "topic_name" || signal.type !== "queue_publish") continue;
      const serviceType = signal.target.serviceType ?? "kafka";
      const id = sanitizeNoteId(`svc:topic:${signal.target.value}`);
      const node = getOrCreateServiceNode(serviceNodesById, id, serviceType, signal.target.value, signal.evidence);
      signal.target.resolvedRepoId = node.id;
      addEdge(edges, seenEdgeIds, repo.repoId, node.id, signal, { broken: false });
    }
  }
  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind !== "topic_name" || signal.type !== "queue_consume") continue;
      const serviceType = signal.target.serviceType ?? "kafka";
      const id = sanitizeNoteId(`svc:topic:${signal.target.value}`);
      const node = getOrCreateServiceNode(serviceNodesById, id, serviceType, signal.target.value, signal.evidence);
      signal.target.resolvedRepoId = node.id;
      addEdge(edges, seenEdgeIds, node.id, repo.repoId, signal, { broken: false });
    }
  }

  // service_resource: repo declara (via IaC) que possui um recurso de infra -> aresta "owns" para o nó de serviço
  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind !== "service_resource" || !signal.target.serviceType) continue;
      const id = sanitizeNoteId(`svc:${signal.target.serviceType}:${signal.target.value}`);
      const node = getOrCreateServiceNode(serviceNodesById, id, signal.target.serviceType, signal.target.value, signal.evidence);
      signal.target.resolvedRepoId = node.id;
      addEdge(edges, seenEdgeIds, repo.repoId, node.id, signal, { broken: false });
    }
  }

  // contract_reference: repos que apontam para um arquivo de contrato com o mesmo nome
  const reposByContractBasename = new Map<string, Array<{ repoId: string; repoPath: string; relativeFile: string }>>();
  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind !== "contract_file") continue;
      const basename = contractBasename(signal.target.value);
      const list = reposByContractBasename.get(basename) ?? [];
      if (!list.some((ref) => ref.repoId === repo.repoId)) {
        list.push({ repoId: repo.repoId, repoPath: repo.repoPath, relativeFile: signal.target.value });
      }
      reposByContractBasename.set(basename, list);
    }
  }
  for (const repo of repos) {
    for (const signal of repo.signals) {
      if (signal.target.kind !== "contract_file") continue;
      const basename = contractBasename(signal.target.value);
      const relatedRefs = (reposByContractBasename.get(basename) ?? []).filter((ref) => ref.repoId !== repo.repoId);

      if (relatedRefs.length === 0) {
        // Contrato ISOLADO: nenhum outro repo do grupo referencia um arquivo com o mesmo nome
        // nesta varredura — sem sibling pra comparar estruturalmente, o único sinal possível é
        // temporal (o schema mudou desde a última vez que vimos?). Materializa como uma edge pra
        // um ServiceNode próprio deste repo (não compartilhado — se fosse compartilhado, já teria
        // caído no branch de sibling acima), carregando o fingerprint de schema que
        // `flagContractSchemaWarnings` compara entre execuções.
        const nodeId = sanitizeNoteId(`svc:contract:${repo.repoId}/${signal.target.value}`);
        const node = getOrCreateServiceNode(serviceNodesById, nodeId, "contract", basename, signal.evidence);
        signal.target.resolvedRepoId = node.id;
        const fingerprint = buildContractSchemaFingerprint(repo.repoPath, signal.target.value);
        addEdge(edges, seenEdgeIds, repo.repoId, node.id, signal, { broken: false }, fingerprint);
        continue;
      }

      for (const relatedRef of relatedRefs) {
        if (repo.repoId >= relatedRef.repoId) continue; // direção canônica, evita edge espelhada duplicada
        signal.target.resolvedRepoId = relatedRef.repoId;
        // Diferente das outras checagens de integridade (que comparam contra um snapshot
        // anterior), esta é estrutural entre as DUAS cópias atuais do mesmo arquivo — ver
        // `checkContractIntegrity`.
        const integrity = checkContractIntegrity(
          repo.repoId,
          repo.repoPath,
          signal.target.value,
          relatedRef.repoId,
          relatedRef.repoPath,
          relatedRef.relativeFile,
        );
        addEdge(edges, seenEdgeIds, repo.repoId, relatedRef.repoId, signal, integrity);
      }
    }
  }

  return {
    group: groupId,
    generatedAt: new Date().toISOString(),
    repos,
    edges,
    serviceNodes: Array.from(serviceNodesById.values()),
  };
}
