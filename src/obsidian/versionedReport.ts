import fs from "node:fs";
import path from "node:path";
import { toFilenameTimestamp } from "../utils/timestamp.js";

/**
 * Mantém um arquivo "atual" sem data/hora no nome (sempre a versão mais recente — fácil de abrir/
 * linkar de novo sem precisar descobrir qual é a última). Antes de escrever a nova versão, se já
 * existir uma versão atual, ela é arquivada usando o timestamp da PRÓPRIA geração dela (lido de
 * dentro do arquivo via `extractGeneratedAt`, não o timestamp de agora) — preserva o histórico
 * completo sem duplicar o "current" a cada rodada.
 */
export function writeCurrentAndArchivePrevious(
  dir: string,
  baseName: string,
  extension: string,
  newContent: string,
  extractGeneratedAt: (content: string) => string | undefined,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const currentPath = path.join(dir, `${baseName}${extension}`);

  if (fs.existsSync(currentPath)) {
    const oldContent = fs.readFileSync(currentPath, "utf8");
    const oldGeneratedAt = extractGeneratedAt(oldContent) ?? fs.statSync(currentPath).mtime.toISOString();
    const archivedPath = path.join(dir, `${toFilenameTimestamp(oldGeneratedAt)}__${baseName}${extension}`);
    fs.renameSync(currentPath, archivedPath);
  }

  fs.writeFileSync(currentPath, newContent, "utf8");
  return currentPath;
}

export function extractHtmlGeneratedAt(content: string): string | undefined {
  return /<meta name="traceability:generated-at" content="([^"]+)"/.exec(content)?.[1];
}

export function extractFrontmatterGeneratedAt(content: string): string | undefined {
  return /^generatedAt: "([^"]+)"$/m.exec(content)?.[1];
}
