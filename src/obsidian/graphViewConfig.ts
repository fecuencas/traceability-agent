import fs from "node:fs";
import path from "node:path";
import { ACTIVE_HEX_COLOR, BROKEN_HEX_COLOR, IMPACTED_HEX_COLOR, WARNING_HEX_COLOR } from "../graph/colorPalette.js";

/**
 * O Graph View nativo do Obsidian reescreve .obsidian/graph.json sozinho durante o uso normal
 * (zoom, arrastar, abrir configurações) — já vimos isso apagar nossas colorGroups. Por isso essa
 * config é reaplicada a cada update_obsidian_graph, em vez de depender de uma edição manual única.
 * Preserva o resto do arquivo (scale, posição, etc.) e só garante os campos que o agente precisa.
 */
function hexToObsidianColor(hex: string): { a: number; rgb: number } {
  return { a: 1, rgb: parseInt(hex.replace("#", ""), 16) };
}

const GRAY = hexToObsidianColor("#9aa5a6");
const GREEN = hexToObsidianColor(ACTIVE_HEX_COLOR);
const RED = hexToObsidianColor(BROKEN_HEX_COLOR);
const ORANGE = hexToObsidianColor(IMPACTED_HEX_COLOR);
const YELLOW = hexToObsidianColor(WARNING_HEX_COLOR);

/**
 * Mesmo farol do relatório HTML e dos diagramas Mermaid: cinza é só o fallback (não deveria
 * aparecer na prática, já que toda nota de repo/integração sempre ganha exatamente uma das tags de
 * status abaixo), vermelho = quebra direta, laranja = impacto em cascata, amarelo = aviso (algo
 * mudou, ex: versão, sem quebra confirmada), verde = sem problema. Substituiu o esquema anterior
 * (uma cor por TIPO de integração — published_artifact_dependency, outbound_http, queue_publish...)
 * que virou ruído visual sem relação com saúde do sistema. Ordem importa: o Graph View colore pelo
 * primeiro grupo que casar, então status (mais específico) vem antes do fallback cinza (mais
 * genérico).
 */
const DESIRED_COLOR_GROUPS = [
  { query: "tag:#broken", color: RED },
  { query: "tag:#removed", color: RED },
  { query: "tag:#impacted", color: ORANGE },
  { query: "tag:#warning", color: YELLOW },
  { query: "tag:#ok", color: GREEN },
  { query: "tag:#repo", color: GRAY },
  { query: "tag:#service", color: GRAY },
  { query: "tag:#integration", color: GRAY },
];

/**
 * O mapa deve mostrar só a topologia real: repositórios (Repos/), nós de serviço de infra
 * (Services/) e suas integrações (Integrations/). Reports/ (relatórios de impacto), Groups/ (nota
 * de agrupamento — não é um repositório de verdade) e index.md (índice geral) são metadados/
 * navegação, não fazem parte do sistema mapeado, e por isso não devem virar nó no Graph View.
 */
const DESIRED_SEARCH_FILTER = "-path:Reports -path:Groups -path:index.md";

export function ensureGraphViewConfig(vaultPath: string): void {
  const filePath = path.join(vaultPath, ".obsidian", "graph.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  config.colorGroups = DESIRED_COLOR_GROUPS;
  config.search = DESIRED_SEARCH_FILTER;
  config.showArrow = true;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
}
