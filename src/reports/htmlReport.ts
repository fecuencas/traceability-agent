import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_HEX_COLOR, BROKEN_HEX_COLOR, IMPACTED_HEX_COLOR, TYPE_HEX_COLORS, WARNING_HEX_COLOR } from "../graph/colorPalette.js";
import { findConnectedComponents } from "../graph/connectedComponents.js";
import { DIFF_HIGHLIGHT_END, DIFF_HIGHLIGHT_START } from "../graph/contractSignature.js";
import { EDGE_LABELS } from "../graph/edgeLabels.js";
import type { GraphEdge, GraphSnapshot } from "../graph/types.js";
import { buildRenderContext, renderMermaidGraph } from "../obsidian/mermaidRenderer.js";

/**
 * Lê o bundle UMD minificado do Mermaid.js (`node_modules/mermaid/dist/mermaid.min.js`) pra embutir
 * inline no relatório — assim o diagrama funciona 100% offline, sem precisar de internet nem de um
 * arquivo separado ao lado do `.html` (o relatório continua sendo um único arquivo autocontido).
 * Resolvido via `import.meta.resolve` (não um caminho relativo fixo) pra funcionar independente de
 * onde o pacote acabou hoisted dentro de `node_modules`. Se por algum motivo não achar (pacote não
 * instalado), retorna `null` e o relatório é gerado sem a seção do diagrama Mermaid, em vez de falhar.
 */
let cachedMermaidScript: string | null | undefined;
function loadMermaidScript(): string | null {
  if (cachedMermaidScript !== undefined) return cachedMermaidScript;
  try {
    const pkgUrl = import.meta.resolve("mermaid/package.json");
    const mermaidDistDir = path.join(path.dirname(fileURLToPath(pkgUrl)), "dist");
    cachedMermaidScript = fs.readFileSync(path.join(mermaidDistDir, "mermaid.min.js"), "utf8");
  } catch {
    cachedMermaidScript = null;
  }
  return cachedMermaidScript;
}

/** Remove a cerca ```mermaid / ``` que `renderMermaidGraph` inclui (pensada pra ir direto num
 * arquivo .md do Obsidian) — no HTML o conteúdo vai dentro de um `<pre class="mermaid">`. */
function stripMermaidFence(diagram: string): string {
  return diagram.replace(/^```mermaid\n/, "").replace(/\n```$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapa a linha inteira primeiro (nunca confia em HTML vindo do conteúdo do contrato), só DEPOIS
 * troca os marcadores de destaque de `serializeFieldSignatureWithHighlight`
 * (`DIFF_HIGHLIGHT_START`/`END`, caracteres de controle que passam ilesos pelo escape) por
 * `<span class="diff-highlight">` — usado nos itens de `contractDiffDetails`. */
function escapeHtmlWithDiffHighlight(line: string): string {
  return escapeHtml(line).replaceAll(
    new RegExp(`${DIFF_HIGHLIGHT_START}(.*?)${DIFF_HIGHLIGHT_END}`, "g"),
    `<span class="diff-highlight">$1</span>`,
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const int = parseInt(hex.replace("#", ""), 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function statTile(label: string, value: number, tone: "neutral" | "danger" | "impacted" | "warning" | "success"): string {
  return `<div class="tile tile-${tone}">
    <span class="tile-value">${value}</span>
    <span class="tile-label">${escapeHtml(label)}</span>
  </div>`;
}

function statusChip(edge: GraphEdge): string {
  if (edge.status === "broken") return `<span class="chip chip-danger">quebrada</span>`;
  if (edge.status === "impacted") return `<span class="chip chip-impacted">impactada</span>`;
  if (edge.status === "removed") return `<span class="chip chip-removed">removida</span>`;
  if (edge.versionWarning) return `<span class="chip chip-warning">versão alterada</span>`;
  return `<span class="chip chip-success">ativa</span>`;
}

function typeChip(edge: GraphEdge): string {
  return `<span class="chip chip-type" style="--chip-color:${TYPE_HEX_COLORS[edge.type]}">${escapeHtml(
    EDGE_LABELS[edge.type].label,
  )}</span>`;
}

function renderIntegrationsTable(edges: GraphEdge[]): string {
  if (edges.length === 0) {
    return `<p class="empty-state">Nenhuma integração detectada neste grupo.</p>`;
  }
  const rows = edges
    .map(
      (edge) => `<tr class="${edge.status === "broken" ? "row-broken" : edge.status === "impacted" ? "row-impacted" : edge.status === "removed" ? "row-removed" : edge.versionWarning ? "row-warning" : ""}">
        <td>${escapeHtml(edge.source)}</td>
        <td>${escapeHtml(edge.target)}</td>
        <td>${typeChip(edge)}</td>
        <td class="mono">${edge.version ? escapeHtml(edge.version) : "—"}</td>
        <td>${statusChip(edge)}</td>
        <td class="mono muted">${escapeHtml(edge.evidence.file)}${edge.evidence.line ? `:${edge.evidence.line}` : ""}</td>
      </tr>`,
    )
    .join("\n");

  return `<div class="table-wrap">
    <table>
      <thead>
        <tr><th>Origem</th><th>Destino</th><th>Tipo</th><th>Versão</th><th>Status</th><th>Evidência</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function problemReason(edge: GraphEdge): string {
  if (edge.status === "removed") {
    return "Não detectada na varredura mais recente — nome de tópico/endpoint/dependência pode ter mudado só de um lado.";
  }
  if (edge.status === "impacted") {
    return edge.brokenReason ?? "Impacto em cascata: depende, a montante, de uma integração corrompida ou removida.";
  }
  return edge.brokenReason ?? "Motivo não especificado.";
}

function renderProblems(edges: GraphEdge[]): string {
  const problems = edges.filter((edge) => edge.status !== "active");
  if (problems.length === 0) {
    return `<div class="empty-state empty-state-ok">Nenhum problema encontrado nesta análise — todas as integrações resolvidas estão íntegras.</div>`;
  }
  return problems
    .map((edge) => {
      const cardClass =
        edge.status === "removed" ? " problem-card-removed" : edge.status === "impacted" ? " problem-card-impacted" : "";
      const reason = problemReason(edge);
      const diffDetails = edge.contractDiffDetails?.length
        ? `<ul class="problem-diff-list">${edge.contractDiffDetails.map((line) => `<li>${escapeHtmlWithDiffHighlight(line)}</li>`).join("")}</ul>`
        : "";
      const evidence = edge.evidence.snippet
        ? `<div class="problem-evidence">
          <span class="muted mono">${escapeHtml(edge.evidence.file)}${edge.evidence.line ? `:${edge.evidence.line}` : ""}</span>
          <pre>${escapeHtml(edge.evidence.snippet)}</pre>
        </div>`
        : `<div class="problem-evidence"><span class="muted mono">${escapeHtml(edge.evidence.file)}</span></div>`;
      return `<article class="problem-card${cardClass}">
        <header>
          <span class="problem-path">${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}</span>
          ${typeChip(edge)}
        </header>
        <p class="problem-reason">${escapeHtml(reason)}</p>
        ${diffDetails}
        ${evidence}
      </article>`;
    })
    .join("\n");
}

/**
 * Separado de `renderProblems` de propósito: um aviso de versão NÃO é uma quebra — a integração
 * continua `active`, o repositório dependente pode continuar funcionando normalmente com a versão
 * anterior. Misturar isso na seção "Problemas encontrados" (que hoje só lista quebra/remoção/
 * cascata) inflaria o pill de "N problemas" com algo que não é um problema, só um "vale revisar".
 */
function renderVersionWarnings(edges: GraphEdge[]): string {
  const warnings = edges.filter((edge) => edge.status === "active" && edge.versionWarning);
  if (warnings.length === 0) {
    return `<div class="empty-state">Nenhum aviso de versão nesta análise.</div>`;
  }
  return warnings
    .map((edge) => {
      const reason =
        edge.version === undefined
          ? "O schema deste contrato mudou desde a última varredura — sem nenhum consumidor mapeado hoje pra confirmar impacto real, mas vale revisar se algum repositório fora deste grupo depende dele."
          : `Versão referenciada mudou para <span class="mono">${escapeHtml(edge.version)}</span> desde a última varredura — a integração continua ativa, mas o repositório dependente pode estar rodando com a versão anterior; vale revalidar.`;
      const diffDetails = edge.contractDiffDetails?.length
        ? `<ul class="problem-diff-list">${edge.contractDiffDetails.map((line) => `<li>${escapeHtmlWithDiffHighlight(line)}</li>`).join("")}</ul>`
        : "";
      const evidence = edge.evidence.snippet
        ? `<div class="problem-evidence">
          <span class="muted mono">${escapeHtml(edge.evidence.file)}${edge.evidence.line ? `:${edge.evidence.line}` : ""}</span>
          <pre>${escapeHtml(edge.evidence.snippet)}</pre>
        </div>`
        : `<div class="problem-evidence"><span class="muted mono">${escapeHtml(edge.evidence.file)}</span></div>`;
      return `<article class="problem-card problem-card-warning">
        <header>
          <span class="problem-path">${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}</span>
          ${typeChip(edge)}
        </header>
        <p class="problem-reason">${reason}</p>
        ${diffDetails}
        ${evidence}
      </article>`;
    })
    .join("\n");
}

/** Um bloco de diagrama completo (toolbar de zoom + viewport arrastável + legenda) — reaproveitado
 * tanto pro caso de 1 aplicação só quanto pra cada componente conectado quando há mais de uma; o
 * JS de pan/zoom já busca `.mermaid-viewport` genericamente, então múltiplos blocos na mesma
 * página funcionam sem nenhuma mudança nele. */
function renderMermaidCard(diagram: string, heading?: string): string {
  return `<div class="graph-card mermaid-card">
        ${heading ? `<h3>${escapeHtml(heading)}</h3>` : ""}
        <div class="mermaid-toolbar" role="group" aria-label="Zoom do diagrama">
          <button type="button" class="mermaid-btn" data-zoom="out" aria-label="Diminuir zoom">−</button>
          <button type="button" class="mermaid-btn mermaid-btn-reset" data-zoom="reset" aria-label="Restaurar zoom">100%</button>
          <button type="button" class="mermaid-btn" data-zoom="in" aria-label="Aumentar zoom">+</button>
        </div>
        <div class="mermaid-viewport">
          <pre class="mermaid">${escapeHtml(diagram)}</pre>
        </div>
        ${renderLegend()}
      </div>`;
}

function renderLegend(): string {
  const edgeItems = [
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${ACTIVE_HEX_COLOR}"></span>fluxo OK</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${WARNING_HEX_COLOR}"></span>aviso (algo mudou, ex: versão — sem quebra confirmada)</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${IMPACTED_HEX_COLOR}"></span>quebra por dependência em cascata</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${BROKEN_HEX_COLOR}"></span>fluxo quebrado</span>`,
    `<span class="legend-item"><span class="legend-dot legend-dot-dashed" style="--dot-color:${BROKEN_HEX_COLOR}"></span>removida (não detectada na última varredura)</span>`,
  ];
  const nodeSeverityItems = [
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${ACTIVE_HEX_COLOR}"></span>sem problema</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${WARNING_HEX_COLOR}"></span>aviso (ex: versão mudou)</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${IMPACTED_HEX_COLOR}"></span>impactado em cascata</span>`,
    `<span class="legend-item"><span class="legend-dot" style="--dot-color:${BROKEN_HEX_COLOR}"></span>quebra direta</span>`,
  ];
  return `<div class="legend"><span class="legend-group-label">Arestas:</span>${edgeItems.join("\n")}</div>
  <div class="legend"><span class="legend-group-label">Nós:</span>${nodeSeverityItems.join("\n")}</div>`;
}

export function renderHtmlReport(snapshot: GraphSnapshot): string {
  const brokenCount = snapshot.edges.filter((edge) => edge.status === "broken").length;
  const impactedCount = snapshot.edges.filter((edge) => edge.status === "impacted").length;
  const removedCount = snapshot.edges.filter((edge) => edge.status === "removed").length;
  const warningCount = snapshot.edges.filter((edge) => edge.status === "active" && edge.versionWarning).length;
  const healthyCount = snapshot.edges.filter((edge) => edge.status === "active").length;
  const problemCount = brokenCount + impactedCount + removedCount;
  const statusPill =
    problemCount > 0
      ? `<span class="pill pill-danger">${problemCount} problema${problemCount > 1 ? "s" : ""} encontrado${problemCount > 1 ? "s" : ""}</span>`
      : `<span class="pill pill-success">Nenhum problema encontrado</span>`;

  // Mesma função geradora da nota de Grupo no Obsidian (`renderMermaidGraph`) — sem o subgraph
  // namespaced que o "Mapa geral" do index.md usa (só faz sentido lá pra não colidir ids entre
  // grupos diferentes); aqui, com um grupo só, o formato plano fica mais limpo.
  const repoIds = snapshot.repos.map((repo) => repo.repoId);
  const renderCtx = buildRenderContext(snapshot.repos, snapshot.serviceNodes);
  const mermaidScript = loadMermaidScript();

  // Repositórios no mesmo grupo nem sempre têm relação real entre si — sem separar por componente
  // conectado, aplicações completamente independentes que só compartilham o mesmo config/pasta
  // acabam desenhadas juntas num único diagrama/relatório, como se fossem uma coisa só.
  const serviceNodeIds = snapshot.serviceNodes.map((node) => node.id);
  const components = findConnectedComponents(repoIds, serviceNodeIds, snapshot.edges);
  const multiAppNote =
    components.length > 1
      ? `<p class="multi-app-note">Este grupo tem <strong>${components.length} aplicações sem nenhuma integração entre si</strong> — cada uma abaixo é um componente conectado independente, detectado automaticamente.</p>`
      : "";
  const mermaidCards =
    components.length <= 1
      ? renderMermaidCard(stripMermaidFence(renderMermaidGraph(repoIds, snapshot.edges, renderCtx, { showTypeLabel: true, colorHealthyNodes: true })))
      : components
          .map((component, index) =>
            renderMermaidCard(
              stripMermaidFence(
                renderMermaidGraph(component.repoIds, component.edges, renderCtx, {
                  showTypeLabel: true,
                  colorHealthyNodes: true,
                }),
              ),
              `Aplicação ${index + 1} — ${component.repoIds.length} repositório${component.repoIds.length === 1 ? "" : "s"}, ${component.edges.length} integraç${component.edges.length === 1 ? "ão" : "ões"}`,
            ),
          )
          .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="traceability:generated-at" content="${escapeHtml(snapshot.generatedAt)}" />
<title>Rastreabilidade — ${escapeHtml(snapshot.group)}</title>
<style>
  :root {
    --bg: #f4f7f7;
    --surface: #ffffff;
    --surface-2: #eaf0ef;
    --border: #d7e0df;
    --text: #101819;
    --text-dim: #526062;
    --accent: #0f8a82;
    --accent-soft: #e2f3f1;
    --danger: #c0362c;
    --danger-soft: #fbe7e5;
    --impacted: ${IMPACTED_HEX_COLOR};
    --impacted-soft: ${hexToRgba(IMPACTED_HEX_COLOR, 0.14)};
    --warning: ${WARNING_HEX_COLOR};
    --warning-soft: ${hexToRgba(WARNING_HEX_COLOR, 0.2)};
    --success: #1f7a4d;
    --success-soft: #e6f4ea;
    --font-mono: ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, Helvetica, Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0d1416;
      --surface: #131b1d;
      --surface-2: #1a2426;
      --border: #263335;
      --text: #e6eeee;
      --text-dim: #93a5a6;
      --accent: #5eead4;
      --accent-soft: rgba(94, 234, 212, 0.12);
      --danger: #f2685d;
      --danger-soft: rgba(242, 104, 93, 0.14);
      --impacted: ${IMPACTED_HEX_COLOR};
      --impacted-soft: ${hexToRgba(IMPACTED_HEX_COLOR, 0.18)};
      --warning: ${WARNING_HEX_COLOR};
      --warning-soft: ${hexToRgba(WARNING_HEX_COLOR, 0.22)};
      --success: #4ade80;
      --success-soft: rgba(74, 222, 128, 0.12);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0d1416;
    --surface: #131b1d;
    --surface-2: #1a2426;
    --border: #263335;
    --text: #e6eeee;
    --text-dim: #93a5a6;
    --accent: #5eead4;
    --accent-soft: rgba(94, 234, 212, 0.12);
    --danger: #f2685d;
    --danger-soft: rgba(242, 104, 93, 0.14);
    --impacted: ${IMPACTED_HEX_COLOR};
    --impacted-soft: ${hexToRgba(IMPACTED_HEX_COLOR, 0.18)};
    --warning: ${WARNING_HEX_COLOR};
    --warning-soft: ${hexToRgba(WARNING_HEX_COLOR, 0.22)};
    --success: #4ade80;
    --success-soft: rgba(74, 222, 128, 0.12);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    line-height: 1.5;
  }
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 48px 24px 80px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  header.top {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 20px;
  }
  header.top h1 {
    font-family: var(--font-mono);
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0;
    text-wrap: balance;
  }
  header.top .meta {
    color: var(--text-dim);
    font-size: 0.85rem;
    font-family: var(--font-mono);
  }
  .pill {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 999px;
    letter-spacing: 0.02em;
  }
  .pill-danger { background: var(--danger-soft); color: var(--danger); }
  .pill-success { background: var(--success-soft); color: var(--success); }

  section { display: flex; flex-direction: column; gap: 14px; }
  h2 {
    font-family: var(--font-mono);
    font-size: 0.95rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin: 0;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tile-value {
    font-family: var(--font-mono);
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .tile-label { color: var(--text-dim); font-size: 0.82rem; }
  .tile-danger .tile-value { color: var(--danger); }
  .tile-impacted .tile-value { color: var(--impacted); }
  .tile-warning .tile-value { color: var(--warning); }
  .tile-success .tile-value { color: var(--success); }

  .graph-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
  }
  .mermaid-card h3 {
    margin: 0 0 12px;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }
  .multi-app-note {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .multi-app-note strong { color: var(--text); }
  .mermaid-toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
  .mermaid-btn {
    font-family: var(--font-mono);
    font-size: 0.85rem;
    font-weight: 700;
    line-height: 1;
    padding: 7px 13px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .mermaid-btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .mermaid-btn-reset { font-variant-numeric: tabular-nums; min-width: 52px; }
  /* Janela de tamanho fixo (ocupa o quadrante todo) — o Mermaid ainda renderiza no tamanho
   * natural dele primeiro (sem distorcer nada), e só DEPOIS o JS escala o svg já pronto pra
   * caber por inteiro na janela (proporção preservada). Grid com place-items:center em vez de
   * flexbox pra centralizar: flexbox tem um bug conhecido em que, com overflow, não dá pra rolar
   * até o início de um item centralizado maior que o container — Grid não tem esse problema,
   * necessário aqui porque o zoom pode deixar o diagrama maior que a janela. */
  .mermaid-viewport {
    overflow: auto;
    height: 600px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    padding: 16px;
    cursor: grab;
    display: grid;
    place-items: center;
  }
  .mermaid-viewport.is-dragging { cursor: grabbing; }
  .mermaid-viewport pre.mermaid { margin: 0; width: max-content; }
  .mermaid-viewport svg { display: block; }

  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 16px; font-size: 0.8rem; color: var(--text-dim); }
  .legend-group-label { font-family: var(--font-mono); font-weight: 600; color: var(--text); margin-right: 2px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dot-color); display: inline-block; }
  .legend-dot-dashed { background: transparent; border: 2px dashed var(--dot-color); width: 7px; height: 7px; }

  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); font-size: 0.88rem; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    background: var(--surface-2);
  }
  tbody tr:last-child td { border-bottom: none; }
  tr.row-broken { background: var(--danger-soft); }
  tr.row-impacted { background: var(--impacted-soft); }
  tr.row-warning { background: var(--warning-soft); }
  tr.row-removed { background: var(--surface-2); color: var(--text-dim); }
  .mono { font-family: var(--font-mono); }
  .muted { color: var(--text-dim); }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
  }
  .chip-danger { background: var(--danger-soft); color: var(--danger); }
  .chip-impacted { background: var(--impacted-soft); color: var(--impacted); }
  .chip-warning { background: var(--warning-soft); color: var(--warning); }
  .chip-success { background: var(--success-soft); color: var(--success); }
  .chip-removed { background: var(--surface-2); color: var(--text-dim); }
  .chip-type { background: var(--surface-2); color: var(--text); }
  .chip-type::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--chip-color);
    display: inline-block;
  }

  .problem-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--danger);
    border-radius: 8px;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .problem-card-removed { border-left-color: var(--text-dim); }
  .problem-card-impacted { border-left-color: var(--impacted); }
  .problem-card-warning { border-left-color: var(--warning); }
  .problem-card header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .problem-path { font-family: var(--font-mono); font-weight: 700; font-size: 0.95rem; }
  .problem-reason { margin: 0; color: var(--text); max-width: 65ch; }
  .problem-diff-list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .problem-diff-list li::marker { color: var(--danger); }
  .diff-highlight { color: var(--danger); font-weight: 700; }
  .problem-evidence { display: flex; flex-direction: column; gap: 6px; }
  .problem-evidence pre {
    margin: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 0.8rem;
    overflow-x: auto;
    white-space: pre;
  }

  .empty-state {
    color: var(--text-dim);
    font-size: 0.9rem;
    padding: 16px;
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .empty-state-ok { color: var(--success); border-color: var(--success); background: var(--success-soft); }

  footer {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    color: var(--text-dim);
    font-size: 0.78rem;
    font-family: var(--font-mono);
  }
</style>
</head>
<body>
  <div class="page">
    <header class="top">
      <div>
        <h1>Rastreabilidade — ${escapeHtml(snapshot.group)}</h1>
        <div class="meta">gerado em ${escapeHtml(snapshot.generatedAt)}</div>
      </div>
      ${statusPill}
    </header>

    <section>
      <div class="tiles">
        ${statTile("Repositórios", snapshot.repos.length, "neutral")}
        ${statTile("Nós de serviço", snapshot.serviceNodes.length, "neutral")}
        ${statTile("Integrações", snapshot.edges.length, "neutral")}
        ${statTile("Corrompidas", brokenCount, brokenCount > 0 ? "danger" : "neutral")}
        ${statTile("Impacto em cascata", impactedCount, impactedCount > 0 ? "impacted" : "neutral")}
        ${statTile("Removidas", removedCount, removedCount > 0 ? "danger" : "neutral")}
        ${statTile("Avisos de versão", warningCount, warningCount > 0 ? "warning" : "neutral")}
        ${statTile("Saudáveis", healthyCount, "success")}
      </div>
    </section>

    ${
      mermaidScript
        ? `<section>
      <h2>Diagrama de integrações</h2>
      ${multiAppNote}
      ${mermaidCards}
    </section>`
        : ""
    }

    <section>
      <h2>Problemas encontrados</h2>
      ${renderProblems(snapshot.edges)}
    </section>

    <section>
      <h2>Avisos de versão</h2>
      ${renderVersionWarnings(snapshot.edges)}
    </section>

    <section>
      <h2>Todas as integrações</h2>
      ${renderIntegrationsTable(snapshot.edges)}
    </section>

    <footer>traceability-agent · relatório estático gerado a partir de análise de código-fonte, sem execução de build/testes</footer>
  </div>
  ${
    mermaidScript
      ? `<script>${mermaidScript}</script>
  <script>
    (function () {
      var isDark = document.documentElement.getAttribute("data-theme") === "dark"
        || (document.documentElement.getAttribute("data-theme") !== "light"
          && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default", securityLevel: "strict" });

      // Base = escala o <svg> já renderizado (proporção preservada, nunca distorce) pra caber por
      // inteiro na janela — mesma ideia de "object-fit: contain". Os botões de zoom multiplicam
      // essa base (100% = ajustado à janela, como abre por padrão); acima disso o diagrama fica
      // maior que a janela e arrastar (scroll nativo) serve pra ler os nomes e navegar pelo fluxo.
      function setupPanAndZoom(viewport) {
        var toolbar = viewport.parentElement.querySelector(".mermaid-toolbar");
        var svg = viewport.querySelector("svg");
        if (!svg || !toolbar) return;
        svg.style.maxWidth = "none";

        var box = svg.getBoundingClientRect();
        var naturalWidth = box.width;
        var naturalHeight = box.height;
        var baseScale = 1;
        if (naturalWidth > 0 && naturalHeight > 0) {
          var availableWidth = viewport.clientWidth - 32; // desconta o padding horizontal (16px cada lado)
          var availableHeight = viewport.clientHeight - 32;
          var fit = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
          if (fit > 0 && isFinite(fit)) baseScale = fit;
        }

        var zoom = 1;
        var resetBtn = toolbar.querySelector('[data-zoom="reset"]');

        function apply() {
          svg.style.width = naturalWidth * baseScale * zoom + "px";
          svg.style.height = naturalHeight * baseScale * zoom + "px";
          if (resetBtn) resetBtn.textContent = Math.round(zoom * 100) + "%";
        }
        apply();

        toolbar.addEventListener("click", function (e) {
          var btn = e.target.closest("[data-zoom]");
          if (!btn) return;
          if (btn.dataset.zoom === "in") zoom = Math.min(6, Math.round((zoom + 0.25) * 100) / 100);
          else if (btn.dataset.zoom === "out") zoom = Math.max(0.25, Math.round((zoom - 0.25) * 100) / 100);
          else zoom = 1;
          apply();
        });

        var dragging = false, startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;
        viewport.addEventListener("mousedown", function (e) {
          dragging = true;
          viewport.classList.add("is-dragging");
          startX = e.clientX; startY = e.clientY;
          startScrollLeft = viewport.scrollLeft; startScrollTop = viewport.scrollTop;
        });
        window.addEventListener("mousemove", function (e) {
          if (!dragging) return;
          viewport.scrollLeft = startScrollLeft - (e.clientX - startX);
          viewport.scrollTop = startScrollTop - (e.clientY - startY);
        });
        window.addEventListener("mouseup", function () {
          dragging = false;
          viewport.classList.remove("is-dragging");
        });
      }

      mermaid.run({ querySelector: ".mermaid" }).then(function () {
        document.querySelectorAll(".mermaid-viewport").forEach(setupPanAndZoom);
      });
    })();
  </script>`
      : ""
  }
</body>
</html>
`;
}
