import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

const HTTP_CLIENT_RULES = [
  {
    detectorId: "csharp-dotnet.http-client-scan",
    type: "outbound_http" as const,
    regex: /new HttpClient\(\)|\.GetAsync\(|\.PostAsync\(|new RestClient\(|new RestRequest\(/,
    confidence: "medium" as const,
  },
];

// Confluent.Kafka. MassTransit (outra lib comum em .NET) roteia por convenção/tipo de mensagem, sem
// nome de tópico/fila como string literal numa linha só — gap conhecido, não coberto aqui.
const QUEUE_TOPIC_RULES = [
  {
    detectorId: "csharp-dotnet.kafka-publish-scan",
    type: "queue_publish" as const,
    regex: /producer\s*\.\s*Produce\(\s*"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
  {
    detectorId: "csharp-dotnet.kafka-consume-scan",
    type: "queue_consume" as const,
    regex: /consumer\s*\.\s*Subscribe\(\s*"([^"]+)"/,
    confidence: "medium" as const,
    serviceType: "kafka" as const,
  },
];

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Assume 1 projeto por repositório (mesma limitação de "1 pom.xml na raiz" já aceita pro adapter
 * Maven) — pega o primeiro `*.csproj` encontrado direto na raiz do repo. */
function findCsprojFile(repoPath: string): string | undefined {
  return fs.readdirSync(repoPath).find((name) => name.endsWith(".csproj"));
}

export const csharpDotnetAdapter: LanguageAdapter = {
  id: "csharp-dotnet",

  matches(repoPath: string): boolean {
    return findCsprojFile(repoPath) !== undefined;
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const csprojFile = findCsprojFile(repoPath) as string;
    const rawText = fs.readFileSync(path.join(repoPath, csprojFile), "utf8");
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(rawText);
    const project = parsed.Project ?? {};
    const propertyGroups = toArray<Record<string, unknown>>(project.PropertyGroup);
    const packageId = propertyGroups.map((group) => group?.PackageId).find((value) => value !== undefined) as
      | string
      | undefined;
    const version = propertyGroups.map((group) => group?.Version).find((value) => value !== undefined) as
      | string
      | undefined;

    const coordinates: RepoCoordinates = {
      packageName: packageId ?? path.basename(csprojFile, ".csproj"),
      version: version ?? "unknown",
    };

    const signals: IntegrationSignal[] = [];

    const itemGroups = toArray<Record<string, unknown>>(project.ItemGroup);
    interface PackageReference {
      "@_Include"?: string;
      "@_Version"?: string;
    }
    const packageReferences = itemGroups.flatMap((group) => toArray<PackageReference>(group?.PackageReference as PackageReference | PackageReference[] | undefined));

    for (const ref of packageReferences) {
      const packageName = ref["@_Include"];
      if (!packageName) continue;
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: csprojFile, snippet: `<PackageReference Include="${packageName}" Version="${ref["@_Version"] ?? ""}" />` },
        target: { kind: "repo_coordinate", value: packageName },
        detectorId: "csharp-dotnet.dependency-scan",
        confidence: "high",
        version: ref["@_Version"] ?? "unknown",
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".cs"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".cs"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "csharp-dotnet.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "csharp",
      buildSystem: "dotnet",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
