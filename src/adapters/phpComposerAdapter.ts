import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, LanguageAdapter, RepoAnalysisResult, RepoCoordinates } from "./types.js";
import { scanCodePatterns, scanContractFiles, scanTopicPatterns } from "./scanUtils.js";

interface ComposerJson {
  name?: string;
  version?: string;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
}

// PHP tem o MAIOR risco de colisão dos 4 adapters novos: uma classe de domínio chamada `Client`
// (`App\Domain\Payment\Client`) é comum o bastante que um regex `new Client(` bare pegaria
// instanciação de código do próprio usuário, não só do Guzzle — por isso exige o FQCN completo.
// Gap conhecido, aceito de propósito: como a URL só resolve pra edge real quando está na MESMA
// linha do marcador (limitação de todos os adapters, não só este), só detecta o estilo encadeado
// numa linha só (`(new \GuzzleHttp\Client())->get($url)`) — construtor e chamada em variável
// separada em linhas diferentes (`$client = new Client(); $client->get($url);`, também muito comum
// em código Guzzle real) não é capturado, já que exigir `->get(`/`->post(` sozinho reintroduziria
// o mesmo risco de colisão que a FQCN completa foi escolhida pra evitar.
const HTTP_CLIENT_RULES = [
  {
    detectorId: "php-composer.http-client-scan",
    type: "outbound_http" as const,
    regex: /new \\?GuzzleHttp\\Client\(|curl_init\(|curl_exec\(/,
    confidence: "medium" as const,
  },
];

// php-amqplib — depende de posição do argumento (mensagem antes ou depois da fila varia por
// versão/uso), então é best-effort: cobre o padrão mais comum, não toda variação possível.
const QUEUE_TOPIC_RULES = [
  {
    detectorId: "php-composer.amqp-publish-scan",
    type: "queue_publish" as const,
    regex: /channel->basic_publish\(\s*\$?\w+,\s*'([^']+)'/,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
  {
    detectorId: "php-composer.amqp-consume-scan",
    type: "queue_consume" as const,
    regex: /channel->basic_consume\(\s*'([^']+)'/,
    confidence: "medium" as const,
    serviceType: "aws-sqs" as const,
  },
];

export const phpComposerAdapter: LanguageAdapter = {
  id: "php-composer",

  matches(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "composer.json"));
  },

  analyze(repoPath: string, repoId: string): RepoAnalysisResult {
    const composerPath = path.join(repoPath, "composer.json");
    const composer = JSON.parse(fs.readFileSync(composerPath, "utf8")) as ComposerJson;

    const coordinates: RepoCoordinates = {
      packageName: composer.name ?? repoId,
      // Composer normalmente não fixa versão no manifesto (usa tag git) — mesma limitação já
      // documentada pra Go/Cargo/CMake, ecossistemas sem campo de versão auto-declarado confiável.
      version: composer.version ?? "unknown",
    };

    const signals: IntegrationSignal[] = [];

    const dependencies = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
    for (const [packageName, versionConstraint] of Object.entries(dependencies)) {
      if (packageName === "php") continue; // não é dependência de outro repo, é a própria constraint de runtime
      signals.push({
        type: "published_artifact_dependency",
        evidence: { file: "composer.json", snippet: `"${packageName}": "${versionConstraint}"` },
        target: { kind: "repo_coordinate", value: packageName },
        detectorId: "php-composer.dependency-scan",
        confidence: "high",
        version: versionConstraint,
      });
    }

    signals.push(...scanCodePatterns(repoPath, [".php"], HTTP_CLIENT_RULES));
    signals.push(...scanTopicPatterns(repoPath, [".php"], QUEUE_TOPIC_RULES));
    signals.push(...scanContractFiles(repoPath, "php-composer.contract-scan"));

    return {
      repoId,
      repoPath,
      language: "php",
      buildSystem: "composer",
      coordinates,
      scannedAt: new Date().toISOString(),
      signals,
    };
  },
};
