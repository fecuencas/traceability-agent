import fs from "node:fs";
import { walkFiles } from "./scanUtils.js";
import type { RepoAnalysisResult } from "./types.js";

/**
 * Varre os arquivos-fonte de um repositório e retorna as classes totalmente qualificadas
 * importadas que pertencem ao `groupId` informado (ex: "io.github.mpontoc").
 * Cobre a sintaxe de import do Java (`import x.y.Z;`) e do Kotlin (`import x.y.Z`, sem `;`).
 */
export function findImportedClasses(repoPath: string, groupId: string, extensions: string[]): string[] {
  const files = walkFiles(repoPath, extensions);
  const found = new Set<string>();
  const importRegex = /^\s*import\s+([\w.]+)\s*;?\s*$/gm;

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    const regex = new RegExp(importRegex.source, importRegex.flags);
    while ((match = regex.exec(content)) !== null) {
      const fqcn = match[1];
      if (fqcn.startsWith(`${groupId}.`) && !fqcn.endsWith(".*")) {
        found.add(fqcn);
      }
    }
  }

  return Array.from(found).sort();
}

/**
 * Como `findImportedClasses`, mas exclui imports que na verdade pertencem a um groupId "irmão"
 * mais específico de OUTRO repo do grupo — ex: alvo com groupId "com.repotestes" não deve
 * reivindicar um import de "com.repotestes.fulfillment.X", que pertence a um repo diferente cujo
 * groupId ("com.repotestes.fulfillment") é um prefixo mais específico. Sem essa exclusão, um
 * groupId "pai" rouba imports que na verdade são de um groupId "filho" de outro repo do mesmo
 * grupo — usado tanto na checagem de integridade (`integrityChecker.ts`) quanto na geração de
 * testes de regressão (`testgen/*.ts`), que tinham essa mesma checagem duplicada (ou, no caso dos
 * geradores de teste, nem tinham, gerando um teste que afirma a existência da classe errada).
 */
export function findRelevantImportedClasses(
  repoPath: string,
  targetGroupId: string,
  otherRepos: RepoAnalysisResult[],
  extensions: string[],
): string[] {
  const importedClasses = findImportedClasses(repoPath, targetGroupId, extensions);
  if (importedClasses.length === 0) return importedClasses;

  const moreSpecificSiblingGroupIds = otherRepos
    .map((repo) => repo.coordinates.groupId)
    .filter(
      (groupId): groupId is string =>
        groupId !== undefined && groupId.length > targetGroupId.length && groupId.startsWith(`${targetGroupId}.`),
    );

  return importedClasses.filter((fqcn) => !moreSpecificSiblingGroupIds.some((siblingGroupId) => fqcn.startsWith(`${siblingGroupId}.`)));
}
