import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

// Nunca usar `\bClient::new\(\)` sozinho: `pub struct Client` é o wrapper HTTP idiomático de
// praticamente todo crate Rust — mesma classe de falso-positivo já achada com `RestTemplate`.
// Sempre exigir o módulo real (`reqwest::`/`hyper::`).
const HTTP_CLIENT_RULES = [
  {
    detectorId: "rust-cargo.http-client-scan",
    type: "outbound_http" as const,
    regex: /reqwest::get\(|reqwest::Client::new\(\)|hyper::Client::new\(\)/,
    confidence: "medium" as const,
  },
];

const QUEUE_TOPIC_RULES = [
  {
    detectorId: "rust-cargo.kafka-publish-scan",
    type: "queue_publish" as const,
    regex: /FutureRecord::to\("([^"]+)"\)/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "rust-cargo.kafka-consume-scan",
    type: "queue_consume" as const,
    regex: /\.subscribe\(&\["([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
];

interface TomlSection {
  name: string;
  lines: string[];
}

/** Parser linha-a-linha bem simples — mesmo espírito do scan manual do CMake (`cppCmakeAdapter`),
 * não um parser TOML completo. Suficiente pra `[package]`/`[dependencies]`/`[dev-dependencies]`
 * no formato padrão gerado por `cargo new`/`cargo add` (chave = valor, um por linha). */
function splitTomlSections(content: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection | undefined;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    const headerMatch = /^\[([\w.-]+)\]$/.exec(trimmed);
    if (headerMatch) {
      current = { name: headerMatch[1], lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(trimmed);
  }
  return sections;
}

function extractStringField(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

export const rustCargoAdapter: LanguageAdapter = {
  id: "rust-cargo",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "Cargo.toml"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const cargoTomlContent = fs.readFileSync(path.join(repoPath, "Cargo.toml"), "utf8");
    const sections = splitTomlSections(cargoTomlContent);

    const packageSection = sections.find((section) => section.name === "package");
    const coordinates: RepoCoordinates = {
      packageName: packageSection ? extractStringField(packageSection.lines, "name") : undefined,
      version: (packageSection && extractStringField(packageSection.lines, "version")) ?? "unknown",
    };

    const signals: IntegrationSignal[] = [];

    for (const section of sections) {
      if (section.name !== "dependencies" && section.name !== "dev-dependencies") continue;
      for (const line of section.lines) {
        // Cobre `nome = "1.2.3"` e `nome = { version = "1.2.3", ... }` — ignora dependência de
        // caminho local (`path = "..."`, sem versão de crate publicado, nada a resolver aqui).
        const simpleMatch = /^([\w-]+)\s*=\s*"([^"]+)"/.exec(line);
        const tableMatch = /^([\w-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);
        const match = simpleMatch ?? tableMatch;
        if (!match) continue;
        signals.push({
          type: "published_artifact_dependency",
          evidence: { file: "Cargo.toml", snippet: line },
          target: { kind: "repo_coordinate", value: match[1] },
          detectorId: "rust-cargo.dependency-scan",
          confidence: "high",
          version: match[2],
        });
      }
    }

    signals.push(...scanCodePatterns(repoPath, [".rs"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".rs"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "rust-cargo.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "rust",
      buildSystem: "cargo",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
