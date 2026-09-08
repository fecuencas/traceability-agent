import { walkFiles } from "./scanUtils.js";

/**
 * Detecta a linguagem-fonte predominante de um repositório contando arquivos .java vs .kt.
 * Necessário porque o build system (Maven/Gradle) nem sempre reflete a linguagem real do código —
 * ex: um projeto Maven pode ter o código-fonte todo em Kotlin via kotlin-maven-plugin.
 */
export function detectDominantSourceLanguage(repoPath: string): "java" | "kotlin" {
  const kotlinFiles = walkFiles(repoPath, [".kt"]).length;
  const javaFiles = walkFiles(repoPath, [".java"]).length;
  return kotlinFiles > javaFiles ? "kotlin" : "java";
}
