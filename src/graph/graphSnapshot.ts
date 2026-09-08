import fs from "node:fs";
import path from "node:path";
import type { GraphSnapshot } from "./types.js";

/** `.traceability/config.json` -> `.traceability/state` (mesmo diretório .traceability do projeto rastreado). */
function stateDirFor(configPath: string): string {
  return path.join(path.dirname(configPath), "state");
}

function currentSnapshotPath(configPath: string): string {
  return path.join(stateDirFor(configPath), "graph-snapshot.json");
}

function historyDir(configPath: string): string {
  return path.join(stateDirFor(configPath), "history");
}

/** Deliberadamente SEPARADO de `graph-snapshot.json`/`history/` (que são só do fluxo de
 * `analyze_impact`, avançados só sob pedido explícito) — `update_obsidian_graph`/
 * `generate_html_report` rodam com muito mais frequência (qualquer regeneração do grafo/relatório),
 * e precisam de sua PRÓPRIA baseline "o que eu vi da última vez que desenhei o grafo" pra calcular
 * `versionWarning` (ver `versionWarnings.ts`). Se usassem o mesmo arquivo do `analyze_impact`,
 * regenerar o grafo a toda hora avançaria a baseline dele sem pedido explícito, escondendo mudanças
 * que um `analyze_impact` posterior deveria detectar. Sem histórico — é só um marcador de "última
 * vez", sempre sobrescrito. */
function renderBaselinePath(configPath: string): string {
  return path.join(stateDirFor(configPath), "render-baseline.json");
}

export function loadSnapshot(configPath: string): GraphSnapshot | undefined {
  const filePath = currentSnapshotPath(configPath);
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as GraphSnapshot;
}

export function loadRenderBaseline(configPath: string): GraphSnapshot | undefined {
  const filePath = renderBaselinePath(configPath);
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as GraphSnapshot;
}

/** Sobrescreve a baseline de renderização com o snapshot atual — sem archiving, ao contrário de
 * `saveSnapshot`. Chamar DEPOIS de calcular `versionWarning` com a baseline antiga, nunca antes. */
export function saveRenderBaseline(configPath: string, snapshot: GraphSnapshot): void {
  const filePath = renderBaselinePath(configPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
}

/** Salva o novo snapshot como o atual, movendo o snapshot anterior (se existir) para history/. */
export function saveSnapshot(configPath: string, snapshot: GraphSnapshot): void {
  const filePath = currentSnapshotPath(configPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(historyDir(configPath), { recursive: true });

  if (fs.existsSync(filePath)) {
    const previous = JSON.parse(fs.readFileSync(filePath, "utf8")) as GraphSnapshot;
    const safeTimestamp = previous.generatedAt.replace(/[:.]/g, "-");
    fs.renameSync(filePath, path.join(historyDir(configPath), `${safeTimestamp}.json`));
  }

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
}
