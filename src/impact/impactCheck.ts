import { analyzeGroup } from "../config/groupAnalysis.js";
import { loadSnapshot, saveSnapshot } from "../graph/graphSnapshot.js";
import { diffGraphs, type ImpactDiff } from "./diffEngine.js";

export interface RunImpactCheckOptions {
  configPath?: string;
  repoId: string;
  /** Persiste o snapshot atual como novo baseline (o anterior migra pra `state/history/`). Default
   * `true`, pra manter o comportamento de sempre da tool `analyze_impact`. Passar `false` quando
   * quem chama só quer checar impacto sem recalibrar o que conta como "antes" pra próxima chamada
   * — ex: um gatilho dev-time chamado várias vezes durante uma sessão de edição exploratória, ainda
   * sem commit (ver Fase 8 do plano de produtização: nenhum dos 3 gatilhos foi implementado ainda,
   * só este núcleo compartilhado que eles vão reaproveitar). */
  persist?: boolean;
}

/**
 * Núcleo de "o que quebra e quem é impactado" — antes só existia inline dentro da tool
 * `analyze_impact`. Extraído pra cá pra poder ser reaproveitado por qualquer superfície futura que
 * precise da mesma checagem (a própria `analyze_impact`, o recálculo somente-leitura de
 * `generate_impact_report`, e — quando forem implementados — os 3 gatilhos "mitigar durante a
 * codificação" desenhados na Fase 8: tool MCP pro agente de código, git hook local, gate de CI).
 */
export function runImpactCheck(options: RunImpactCheckOptions): ImpactDiff {
  const { config, snapshot: currentSnapshot } = analyzeGroup(options.configPath);
  const previousSnapshot = loadSnapshot(config.configPath);
  const diff = diffGraphs(options.repoId, previousSnapshot, currentSnapshot);
  if (options.persist ?? true) saveSnapshot(config.configPath, currentSnapshot);
  return diff;
}
