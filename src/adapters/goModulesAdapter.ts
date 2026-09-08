import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

// Nunca usar `\bClient\b` sozinho: `type Client struct {}` é idiomático em Go (todo pacote HTTP
// costuma expor um wrapper chamado exatamente "Client") — mesma classe de falso-positivo já achada
// nesta sessão com `RestTemplate` em Java. Sempre exigir o prefixo real do pacote.
const HTTP_CLIENT_RULES = [
  {
    detectorId: "go-modules.http-client-scan",
    type: "outbound_http" as const,
    regex: /http\.Get\(|http\.Post\(|http\.NewRequest\(|http\.DefaultClient\.Do\(|resty\.New\(\)|\.R\(\)\.(?:Get|Post|Put|Delete)\(/,
    confidence: "medium" as const,
  },
];

// kafka-go expõe o tópico como campo de struct literal (`kafka.Writer{Topic: "..."}` pro publisher,
// `kafka.ReaderConfig{Topic: "..."}` pro consumer). `sarama` (outra lib comum em Go) usa builder
// pattern sem literal numa linha só — gap conhecido, não vale um regex frágil só pra fingir cobertura.
// `NESTED_BRACE_TOLERANT` tolera UM nível de chave aninhada antes de achar `Topic:` — necessário
// pro uso idiomático mais comum de `ReaderConfig` de verdade (`Brokers: []string{"host:9092"}` tem
// uma chave fechando ANTES de chegar em `Topic:`; um `[^}]*` simples pararia cedo demais ali).
const NESTED_BRACE_TOLERANT = "(?:[^{}]|\\{[^{}]*\\})*";
const QUEUE_TOPIC_RULES = [
  {
    detectorId: "go-modules.kafka-publish-scan",
    type: "queue_publish" as const,
    regex: new RegExp(`kafka\\.Writer\\{${NESTED_BRACE_TOLERANT}Topic:\\s*"([^"]+)"`),
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "go-modules.kafka-consume-scan",
    type: "queue_consume" as const,
    regex: new RegExp(`kafka\\.ReaderConfig\\{${NESTED_BRACE_TOLERANT}Topic:\\s*"([^"]+)"`),
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
];

/** Casa `require x v1.2.3` (forma de linha única) — a forma em bloco (`require (\n x v1.2.3\n)`)
 * também bate, já que cada linha dentro do bloco tem exatamente esse formato. */
const REQUIRE_LINE = /^([\w./-]+)\s+v([\w.-]+)/;
const MODULE_LINE = /^module\s+([\w./-]+)/;

export const goModulesAdapter: LanguageAdapter = {
  id: "go-modules",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "go.mod"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const goModContent = fs.readFileSync(path.join(repoPath, "go.mod"), "utf8");

    // Go modules não se auto-declaram uma versão (a versão vem da tag git de quem consome) — mesma
    // limitação documentada em cppCmakeAdapter/rustCargoAdapter pra ecossistemas sem campo de versão próprio.
    const coordinates: RepoCoordinates = { version: "unknown" };

    const signals: IntegrationSignal[] = [];
    let insideRequireBlock = false;

    for (const rawLine of goModContent.split("\n")) {
      const trimmed = rawLine.trim();

      const moduleMatch = MODULE_LINE.exec(trimmed);
      if (moduleMatch) coordinates.packageName = moduleMatch[1];

      if (trimmed === "require (") {
        insideRequireBlock = true;
        continue;
      }
      if (insideRequireBlock && trimmed === ")") {
        insideRequireBlock = false;
        continue;
      }

      const isRequireLine = insideRequireBlock || trimmed.startsWith("require ");
      if (!isRequireLine) continue;
      const withoutKeyword = trimmed.replace(/^require\s+/, "");
      const match = REQUIRE_LINE.exec(withoutKeyword);
      if (!match) continue;

      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "go.mod", snippet: trimmed },
        target: { kind: "repo_coordinate", value: match[1] },
        detectorId: "go-modules.dependency-scan",
        confidence: "high",
        version: match[2],
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".go"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".go"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "go-modules.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "go",
      buildSystem: "go-modules",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
