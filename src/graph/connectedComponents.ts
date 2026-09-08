import type { GraphEdge } from "./types.js";

/**
 * Um subconjunto de repositórios/nós de serviço mutuamente alcançáveis entre si por alguma
 * integração — na prática, uma "aplicação" real dentro de um grupo que pode conter várias sem
 * nenhuma relação entre elas (ex: repos que só compartilham a mesma pasta/config, sem nunca se
 * chamar). `repoIds`/`edges` vêm ordenados pela ordem original recebida, não pela ordem de
 * descoberta do union-find.
 */
export interface GraphComponent {
  repoIds: string[];
  serviceNodeIds: string[];
  edges: GraphEdge[];
}

/**
 * Agrupa repositórios e nós de serviço em componentes conectados, tratando as edges como
 * não-direcionadas só pra esse propósito (a direção real de cada integração continua preservada
 * dentro de `edges`). Sem isso, um grupo/config que reúne repositórios sem NENHUMA relação entre
 * si (mesma pasta, times diferentes) é sempre desenhado como se fosse uma única aplicação — este
 * agrupamento permite ao Grupo/relatório HTML detectar automaticamente quando na verdade existe
 * mais de uma aplicação lá dentro e separá-las visualmente, em vez de depender de o usuário criar
 * um `.traceability/config.json`/grupo manual pra cada uma.
 */
export function findConnectedComponents(
  repoIds: string[],
  serviceNodeIds: string[],
  edges: GraphEdge[],
): GraphComponent[] {
  const parent = new Map<string, string>();

  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const allIds = [...repoIds, ...serviceNodeIds];
  for (const id of allIds) find(id); // garante que todo nó, mesmo sem nenhuma edge, forme seu próprio componente
  for (const edge of edges) union(edge.source, edge.target);

  const repoIdsByRoot = new Map<string, string[]>();
  const serviceNodeIdsByRoot = new Map<string, string[]>();
  for (const id of repoIds) {
    const root = find(id);
    (repoIdsByRoot.get(root) ?? repoIdsByRoot.set(root, []).get(root)!).push(id);
  }
  for (const id of serviceNodeIds) {
    const root = find(id);
    (serviceNodeIdsByRoot.get(root) ?? serviceNodeIdsByRoot.set(root, []).get(root)!).push(id);
  }

  const edgesByRoot = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const root = find(edge.source);
    (edgesByRoot.get(root) ?? edgesByRoot.set(root, []).get(root)!).push(edge);
  }

  const roots = new Set([...repoIdsByRoot.keys(), ...serviceNodeIdsByRoot.keys()]);
  const components: GraphComponent[] = Array.from(roots, (root) => ({
    repoIds: repoIdsByRoot.get(root) ?? [],
    serviceNodeIds: serviceNodeIdsByRoot.get(root) ?? [],
    edges: edgesByRoot.get(root) ?? [],
  }));

  // Maior primeiro — a aplicação "principal" (mais repositórios) aparece no topo do relatório/nota.
  components.sort((a, b) => b.repoIds.length - a.repoIds.length);
  return components;
}
