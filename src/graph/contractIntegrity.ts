import fs from "node:fs";
import path from "node:path";
import type { ContractFieldSignature } from "./contractSignature.js";
import {
  diffFieldAttributes,
  extractContractOperations,
  extractContractSchemas,
  serializeFieldSignature,
  serializeFieldSignatureWithHighlight,
} from "./contractSignature.js";

export interface ContractIntegrityResult {
  broken: boolean;
  /** Frase curta — usada nos lugares de resumo compacto (tabela, resumo de risco). */
  reason?: string;
  /** Uma linha por divergência (operação ou campo), já formatada pra virar item de lista — usada
   * nos lugares com espaço pra detalhar (nota de integração, relatório HTML). Ver
   * `GraphEdge.contractDiffDetails`. */
  diffDetails?: string[];
}

function diffOperations(repoAId: string, opsA: Set<string>, repoBId: string, opsB: Set<string>): string[] {
  // presente em A, ausente em B -> repoB ficou pra trás nessa operação (e vice-versa)
  const missingInB = Array.from(opsA).filter((op) => !opsB.has(op)).sort();
  const missingInA = Array.from(opsB).filter((op) => !opsA.has(op)).sort();
  return [
    ...missingInB.map((op) => `ausente em ${repoBId}: ${op}`),
    ...missingInA.map((op) => `ausente em ${repoAId}: ${op}`),
  ];
}

/**
 * Compara campo-a-campo (tipo, obrigatoriedade, restrições) as duas cópias ATUAIS de um contrato —
 * "os dois lados ainda falam da mesma forma sobre este campo?". Ao contrário do diff temporal
 * (`diffContractFingerprints`, contra a própria execução anterior), aqui não importa QUEM mudou
 * primeiro: um campo divergente entre dois consumidores do mesmo contrato já é evidência direta de
 * quebra, independente de histórico. Quando os dois lados têm o campo mas com atributos diferentes,
 * gera DUAS linhas (uma por repo, não uma só combinada) — cada uma com só o(s) atributo(s) que
 * realmente divergem destacados via `DIFF_HIGHLIGHT_START`/`END` (ex: só `type=number`, não a linha
 * inteira) — cada renderizador (nota do Obsidian, relatório HTML) decide como colorir esse destaque.
 */
function diffSchemasBetweenRepos(
  repoAId: string,
  schemasA: Map<string, ContractFieldSignature>,
  repoBId: string,
  schemasB: Map<string, ContractFieldSignature>,
): string[] {
  const details: string[] = [];
  const keys = new Set([...schemasA.keys(), ...schemasB.keys()]);
  for (const key of Array.from(keys).sort()) {
    const sigA = schemasA.get(key);
    const sigB = schemasB.get(key);
    if (!sigA) {
      details.push(`${key}: presente em ${repoBId}, ausente em ${repoAId}`);
      continue;
    }
    if (!sigB) {
      details.push(`${key}: presente em ${repoAId}, ausente em ${repoBId}`);
      continue;
    }
    const highlightAttributes = diffFieldAttributes(sigA, sigB);
    if (highlightAttributes.size === 0) continue;
    details.push(`${key}: ${repoAId} declara "${serializeFieldSignatureWithHighlight(sigA, highlightAttributes)}"`);
    details.push(`${key}: ${repoBId} declara "${serializeFieldSignatureWithHighlight(sigB, highlightAttributes)}"`);
  }
  return details;
}

/**
 * Verifica, de forma estática, se as DUAS cópias de um mesmo arquivo de contrato (mesmo nome,
 * referenciado pelos dois repos) ainda declaram exatamente as mesmas operações E os mesmos campos
 * (tipo/obrigatoriedade/restrições) em `components.schemas`. Ao contrário de
 * `checkPublishedArtifactIntegrity` (que compara contra o snapshot anterior), esta checagem é
 * estrutural entre as duas cópias ATUAIS — não precisa de histórico: se `orders-api-provider` e
 * `orders-api-consumer` referenciam um `openapi.yaml` com o mesmo nome mas os conteúdos divergiram,
 * isso já é evidência direta de contrato quebrado entre as duas partes, sem precisar saber qual
 * delas mudou primeiro. Quando HÁ um consumidor mapeado (esta função só é chamada nesse caso — ver
 * `graphBuilder.ts`), qualquer divergência vira quebra real (`broken`); o caso sem consumidor
 * mapeado usa `diffContractFingerprints` (temporal, contra a execução anterior) e vira `warning`,
 * não `broken` — ver `contractSchemaWarnings.ts`.
 */
export function checkContractIntegrity(
  repoAId: string,
  repoAPath: string,
  relativeFileA: string,
  repoBId: string,
  repoBPath: string,
  relativeFileB: string,
): ContractIntegrityResult {
  const fileAPath = path.join(repoAPath, relativeFileA);
  const fileBPath = path.join(repoBPath, relativeFileB);

  // Mesmo guard rail de `checkPublishedArtifactIntegrity`: um repo resolvido via manifesto (Fase 6)
  // pode não ter código-fonte disponível localmente — tratar "não consigo ler" como "quebrado"
  // seria falso-positivo.
  if (!fs.existsSync(fileAPath) || !fs.existsSync(fileBPath)) return { broken: false };

  const contentA = fs.readFileSync(fileAPath, "utf8");
  const contentB = fs.readFileSync(fileBPath, "utf8");
  const basenameA = path.basename(relativeFileA);
  const basenameB = path.basename(relativeFileB);

  const opsA = extractContractOperations(basenameA, contentA);
  const opsB = extractContractOperations(basenameB, contentB);
  const opDiffDetails = opsA && opsB ? diffOperations(repoAId, opsA, repoBId, opsB) : [];

  const schemasA = extractContractSchemas(basenameA, contentA);
  const schemasB = extractContractSchemas(basenameB, contentB);
  const schemaDiffDetails = schemasA && schemasB ? diffSchemasBetweenRepos(repoAId, schemasA, repoBId, schemasB) : [];

  const diffDetails = [...opDiffDetails, ...schemaDiffDetails];
  if (diffDetails.length === 0) return { broken: false };

  const total = diffDetails.length;
  return {
    broken: true,
    reason: `Contrato de ${basenameA} divergente entre ${repoAId} e ${repoBId} (${total} diverg${total > 1 ? "ências" : "ência"} encontrada${total > 1 ? "s" : ""}).`,
    diffDetails,
  };
}

/** Fingerprint (uma string serializada por campo) de todos os campos de `components.schemas` de UM
 * arquivo — usado só quando o contrato é ISOLADO (nenhum sibling conhecido pra comparar contra),
 * pra guardar no `GraphEdge` e comparar contra a execução anterior (`flagContractSchemaWarnings`).
 * `undefined` quando o repo não está disponível localmente ou o formato não tem diff estrutural
 * suportado (mesmo critério de `extractContractSchemas`). */
export function buildContractSchemaFingerprint(repoPath: string, relativeFile: string): Record<string, string> | undefined {
  const filePath = path.join(repoPath, relativeFile);
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, "utf8");
  const schemas = extractContractSchemas(path.basename(relativeFile), content);
  if (!schemas) return undefined;
  const fingerprint: Record<string, string> = {};
  for (const [key, signature] of schemas) fingerprint[key] = serializeFieldSignature(signature);
  return fingerprint;
}

/** Diff TEMPORAL entre dois fingerprints do MESMO arquivo (execução anterior vs atual) — usado só
 * pelo caminho "contrato isolado, sem consumidor mapeado" (`flagContractSchemaWarnings`). */
export function diffContractFingerprints(previous: Record<string, string>, current: Record<string, string>): string[] {
  const details: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of Array.from(keys).sort()) {
    const previousValue = previous[key];
    const currentValue = current[key];
    if (previousValue === undefined) details.push(`${key}: campo novo (${currentValue})`);
    else if (currentValue === undefined) details.push(`${key}: campo removido (era ${previousValue})`);
    else if (previousValue !== currentValue) details.push(`${key}: ${previousValue} → ${currentValue}`);
  }
  return details;
}
