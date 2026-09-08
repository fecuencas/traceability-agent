import fs from "node:fs";
import path from "node:path";
import type { Confidence, IntegrationSignal, IntegrationSignalType, ServiceType } from "./types.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".mvn",
]);

function walk(rootDir: string, onFile: (filePath: string, entryName: string) => void): void {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        onFile(path.join(dir, entry.name), entry.name);
      }
    }
  }
}

export function walkFiles(rootDir: string, extensions: string[]): string[] {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const results: string[] = [];
  walk(rootDir, (filePath) => {
    if (extSet.has(path.extname(filePath).toLowerCase())) results.push(filePath);
  });
  return results;
}

export function findFilesByName(rootDir: string, namePattern: RegExp): string[] {
  const results: string[] = [];
  walk(rootDir, (filePath, entryName) => {
    if (namePattern.test(entryName)) results.push(filePath);
  });
  return results;
}

export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

export interface CodePatternRule {
  detectorId: string;
  type: IntegrationSignalType;
  regex: RegExp;
  confidence: Confidence;
}

const URL_REGEX = /https?:\/\/[^\s"'`]+/;

/** Comentário (`//`, `/*`, `*` de continuação de bloco, `#`) ou linha de import/require/use/using —
 * menção ao nome de um client HTTP nesse contexto não é uso real dele (ex: `import RestTemplate` ou
 * um docstring citando "RestTemplate"), mas o regex de detecção, sozinho, não distingue os dois.
 * `use` cobre PHP (`use GuzzleHttp\Client;`) e Rust (`use reqwest::Client;`); `using` cobre C#
 * (`using System.Net.Http;`) — nenhum dos dois batia antes (achado da Fase 7, adapters novos). */
function isCommentOrImportLine(lineText: string): boolean {
  return (
    /^(\/\/|\/\*|\*|#)/.test(lineText) ||
    /^import\b/.test(lineText) ||
    /^require\b/.test(lineText) ||
    /^use\b/.test(lineText) ||
    /^using\b/.test(lineText)
  );
}

/** A própria DECLARAÇÃO de uma classe/função com o mesmo nome do client detectado (ex: `class
 * RestTemplate {`, `export function fetch(...)`) — comum em stubs locais que reimplementam a
 * assinatura de uma lib real só para permitir compilar offline. Sem esse filtro, o detector marca
 * a declaração do stub como se fosse, ela mesma, uma chamada de saída. Segunda alternativa
 * (`type X struct`/`interface`) cobre a ordem INVERTIDA do Go (`type Client struct {}` — o
 * identificador vem ANTES da palavra-chave, ao contrário de `class X`/`struct X`; achado da Fase 7). */
function isDeclarationOfMatchedIdentifier(lineText: string, matchedText: string): boolean {
  const identifier = matchedText.replace(/[.(]+$/, "").trim();
  if (!identifier) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b(class|function|def|interface|struct)\\s+${escaped}\\b`).test(lineText) ||
    new RegExp(`\\btype\\s+${escaped}\\s+(?:struct|interface)\\b`).test(lineText)
  );
}

/** Faz grep de `rules` sobre todos os arquivos com as extensões dadas dentro de repoPath. */
export function scanCodePatterns(
  repoPath: string,
  extensions: string[],
  rules: CodePatternRule[],
): IntegrationSignal[] {
  const signals: IntegrationSignal[] = [];
  const files = walkFiles(repoPath, extensions);

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const rule of rules) {
      const flags = rule.regex.flags.includes("g") ? rule.regex.flags : rule.regex.flags + "g";
      const regex = new RegExp(rule.regex.source, flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const lineEndIdx = content.indexOf("\n", match.index);
        const lineText = content.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx).trim();
        if (isCommentOrImportLine(lineText) || isDeclarationOfMatchedIdentifier(lineText, match[0])) continue;
        const urlMatch = lineText.match(URL_REGEX);
        signals.push({
          type: rule.type,
          evidence: {
            file: path.relative(repoPath, filePath),
            line: lineNumberAt(content, match.index),
            snippet: lineText,
          },
          target: urlMatch ? { kind: "url", value: urlMatch[0] } : { kind: "unresolved", value: match[0] },
          detectorId: rule.detectorId,
          confidence: rule.confidence,
        });
      }
    }
  }
  return signals;
}

export interface TopicPatternRule {
  detectorId: string;
  type: "queue_publish" | "queue_consume";
  /** Deve ter exatamente um grupo de captura: o nome do tópico/fila. */
  regex: RegExp;
  confidence: Confidence;
  /** Provedor da fila (kafka vs aws-sqs, etc.) — já sabido pelo próprio detector (ex: regex de
   * `@SqsListener` vs `kafkaTemplate`), só precisa ser repassado para o signal para sobreviver até
   * a resolução do grafo. */
  serviceType?: ServiceType;
}

/** Faz grep de `rules` capturando o nome do tópico/fila (target.kind = "topic_name"), permitindo
 * resolver a integração casando o tópico publicado por um repo com o consumido por outro. */
export function scanTopicPatterns(repoPath: string, extensions: string[], rules: TopicPatternRule[]): IntegrationSignal[] {
  const signals: IntegrationSignal[] = [];
  const files = walkFiles(repoPath, extensions);

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const rule of rules) {
      const flags = rule.regex.flags.includes("g") ? rule.regex.flags : rule.regex.flags + "g";
      const regex = new RegExp(rule.regex.source, flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const topic = match[1];
        if (!topic) continue;
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const lineEndIdx = content.indexOf("\n", match.index);
        const lineText = content.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx).trim();
        if (isCommentOrImportLine(lineText)) continue;
        signals.push({
          type: rule.type,
          evidence: {
            file: path.relative(repoPath, filePath),
            line: lineNumberAt(content, match.index),
            snippet: lineText,
          },
          target: { kind: "topic_name", value: topic, serviceType: rule.serviceType },
          detectorId: rule.detectorId,
          confidence: rule.confidence,
        });
      }
    }
  }
  return signals;
}

const CONTRACT_FILE_PATTERN = /\.proto$|openapi\.ya?ml$|swagger\.json$|\.avsc$/i;

/** Detecta arquivos de contrato (proto/OpenAPI/Avro) presentes no repositório. */
export function scanContractFiles(repoPath: string, detectorId: string): IntegrationSignal[] {
  const files = findFilesByName(repoPath, CONTRACT_FILE_PATTERN);
  return files.map((filePath) => ({
    type: "contract_reference" as const,
    evidence: { file: path.relative(repoPath, filePath), snippet: path.basename(filePath) },
    target: { kind: "contract_file" as const, value: path.relative(repoPath, filePath) },
    detectorId,
    confidence: "medium" as const,
  }));
}
