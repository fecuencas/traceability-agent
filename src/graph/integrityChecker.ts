import fs from "node:fs";
import path from "node:path";
import { findRelevantImportedClasses } from "../adapters/importScanner.js";
import type { RepoAnalysisResult } from "../adapters/types.js";

export interface IntegrityResult {
  broken: boolean;
  reason?: string;
}

function classSourceCandidates(repoPath: string, fqcn: string): string[] {
  const relativePath = fqcn.replace(/\./g, path.sep);
  return [
    path.join(repoPath, "src", "main", "java", `${relativePath}.java`),
    path.join(repoPath, "src", "main", "kotlin", `${relativePath}.kt`),
  ];
}

function classExistsInRepo(repoPath: string, fqcn: string): boolean {
  return classSourceCandidates(repoPath, fqcn).some((candidate) => fs.existsSync(candidate));
}

/**
 * Verifica, de forma estática (sem compilar/rodar nada), se as classes do repo-alvo efetivamente
 * importadas pelo repo de origem ainda existem no código-fonte do repo-alvo. Se alguma não existir
 * mais (ex: foi renomeada/removida numa versão nova do repo dependido), a integração é marcada como
 * corrompida já na análise inicial, sem precisar rodar testes/build.
 */
export function checkPublishedArtifactIntegrity(
  sourceRepo: RepoAnalysisResult,
  targetRepo: RepoAnalysisResult | undefined,
  allRepos: RepoAnalysisResult[] = [],
): IntegrityResult {
  const targetGroupId = targetRepo?.coordinates.groupId;
  if (!targetRepo || !targetGroupId) return { broken: false };

  // Um repo resolvido via manifesto (Fase 6) pode ter sido escaneado numa máquina diferente de
  // onde este código roda agora — sem esse checkout local, não dá pra confirmar se a classe existe
  // ou não. Tratar "não consigo checar" como "quebrado" seria um falso-positivo; a decisão correta
  // é pular a checagem (mantém `active`) e avisar, não marcar como corrompido.
  if (!fs.existsSync(sourceRepo.repoPath) || !fs.existsSync(targetRepo.repoPath)) {
    console.warn(
      `[integrityChecker] Pulando checagem de integridade ${sourceRepo.repoId} -> ${targetRepo.repoId}: ` +
        "código-fonte não está disponível localmente (repo resolvido via manifesto?).",
    );
    return { broken: false };
  }

  const otherRepos = allRepos.filter((repo) => repo.repoId !== targetRepo.repoId);
  const relevantImports = findRelevantImportedClasses(sourceRepo.repoPath, targetGroupId, otherRepos, [".java", ".kt"]);
  if (relevantImports.length === 0) return { broken: false };

  const missing = relevantImports.filter((fqcn) => !classExistsInRepo(targetRepo.repoPath, fqcn));
  if (missing.length === 0) return { broken: false };

  return {
    broken: true,
    reason: `Classe(s) não encontrada(s) no código-fonte atual de ${targetRepo.repoId}: ${missing.join(", ")}`,
  };
}
