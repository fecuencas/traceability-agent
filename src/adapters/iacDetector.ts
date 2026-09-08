import fs from "node:fs";
import path from "node:path";
import type { IntegrationSignal, ServiceType } from "./types.js";
import { findFilesByName, lineNumberAt } from "./scanUtils.js";

interface TerraformResourceRule {
  detectorId: string;
  serviceType: ServiceType;
  /** Deve ter exatamente um grupo de captura: o identificador local do recurso (`resource "..." "ESTE"`). */
  regex: RegExp;
}

const TERRAFORM_RULES: TerraformResourceRule[] = [
  {
    detectorId: "iac.terraform.lambda-scan",
    serviceType: "aws-lambda",
    regex: /resource\s+"aws_lambda_function"\s+"([\w-]+)"/,
  },
  {
    detectorId: "iac.terraform.sqs-scan",
    serviceType: "aws-sqs",
    regex: /resource\s+"aws_sqs_queue"\s+"([\w-]+)"/,
  },
  {
    detectorId: "iac.terraform.route53-scan",
    serviceType: "aws-route53",
    regex: /resource\s+"aws_route53_record"\s+"([\w-]+)"/,
  },
  {
    detectorId: "iac.terraform.stepfunctions-scan",
    serviceType: "aws-step-functions",
    regex: /resource\s+"aws_sfn_state_machine"\s+"([\w-]+)"/,
  },
  {
    detectorId: "iac.terraform.ecs-scan",
    serviceType: "aws-ecs",
    regex: /resource\s+"aws_ecs_service"\s+"([\w-]+)"/,
  },
];

interface CloudFormationTypeRule {
  detectorId: string;
  serviceType: ServiceType;
  /** Casa a linha `Type: AWS::...` do recurso — sem grupo de captura, o nome vem da chave YAML acima. */
  typeRegex: RegExp;
}

const CLOUDFORMATION_RULES: CloudFormationTypeRule[] = [
  {
    detectorId: "iac.cloudformation.lambda-scan",
    serviceType: "aws-lambda",
    typeRegex: /Type:\s*AWS::(?:Serverless|Lambda)::Function/,
  },
  { detectorId: "iac.cloudformation.sqs-scan", serviceType: "aws-sqs", typeRegex: /Type:\s*AWS::SQS::Queue/ },
  {
    detectorId: "iac.cloudformation.route53-scan",
    serviceType: "aws-route53",
    typeRegex: /Type:\s*AWS::Route53::RecordSet/,
  },
  {
    detectorId: "iac.cloudformation.stepfunctions-scan",
    serviceType: "aws-step-functions",
    typeRegex: /Type:\s*AWS::StepFunctions::StateMachine/,
  },
  { detectorId: "iac.cloudformation.ecs-scan", serviceType: "aws-ecs", typeRegex: /Type:\s*AWS::ECS::Service/ },
];

function lineTextAt(content: string, index: number): string {
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const lineEndIdx = content.indexOf("\n", index);
  return content.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx).trim();
}

function pushServiceSignal(
  signals: IntegrationSignal[],
  repoPath: string,
  filePath: string,
  content: string,
  index: number,
  name: string,
  serviceType: ServiceType,
  detectorId: string,
): void {
  signals.push({
    type: "service_declaration",
    evidence: { file: path.relative(repoPath, filePath), line: lineNumberAt(content, index), snippet: lineTextAt(content, index) },
    target: { kind: "service_resource", value: name, serviceType },
    detectorId,
    confidence: "medium",
  });
}

function scanTerraformFile(repoPath: string, filePath: string, content: string, signals: IntegrationSignal[]): void {
  for (const rule of TERRAFORM_RULES) {
    const regex = new RegExp(rule.regex.source, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      pushServiceSignal(signals, repoPath, filePath, content, match.index, match[1], rule.serviceType, rule.detectorId);
    }
  }
}

/**
 * Acha a chave YAML (`  NomeDoRecurso:`) mais próxima ANTES de `index` — usada para nomear um
 * recurso CloudFormation/SAM a partir da linha `Type: AWS::...`, que sozinha não carrega o nome
 * (o nome é a chave do recurso, uma ou mais linhas acima, no bloco `Resources:`).
 */
function findPrecedingYamlKey(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const keyRegex = /^(\s{2,4})([\w-]+):\s*$/gm;
  let lastName: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = keyRegex.exec(before)) !== null) {
    lastName = match[2];
  }
  return lastName;
}

function scanCloudFormationFile(repoPath: string, filePath: string, content: string, signals: IntegrationSignal[]): void {
  for (const rule of CLOUDFORMATION_RULES) {
    const regex = new RegExp(rule.typeRegex.source, "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = findPrecedingYamlKey(content, match.index) ?? "recurso-sem-nome";
      pushServiceSignal(signals, repoPath, filePath, content, match.index, name, rule.serviceType, rule.detectorId);
    }
  }
}

/** Best-effort: casa cada função declarada em `functions:` (indentação de 2 espaços) seguida, em
 * algum ponto do bloco, por uma linha `handler:` — não é um parser YAML de verdade, só o suficiente
 * para o formato padrão do serverless.yml. */
const SERVERLESS_FUNCTION_REGEX = /^ {2}([\w-]+):\s*\n(?:[ \t]+.*\n)*?[ \t]*handler:/;

function scanServerlessFile(repoPath: string, filePath: string, content: string, signals: IntegrationSignal[]): void {
  const regex = new RegExp(SERVERLESS_FUNCTION_REGEX.source, "gm");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    pushServiceSignal(signals, repoPath, filePath, content, match.index, match[1], "aws-lambda", "iac.serverless.lambda-scan");
  }
}

function safeRead(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Scanner agnóstico de linguagem: procura declarações de infraestrutura AWS (Lambda, SQS, Route53,
 * Step Functions) em arquivos de infra-as-code do repositório (Terraform `*.tf`, SAM/CloudFormation
 * `template.yaml`, `serverless.yml`). Roda para qualquer repo, independente do adapter de linguagem
 * que o analisou — ver `analyzeRepository` em `adapterRegistry.ts`. Mesmo estilo do resto do
 * projeto: regex sobre texto puro, confiança `medium`, sem parser real de HCL/YAML — o que não
 * bater com esses padrões específicos simplesmente não aparece.
 */
export function scanInfraSignals(repoPath: string): IntegrationSignal[] {
  const signals: IntegrationSignal[] = [];

  for (const filePath of findFilesByName(repoPath, /\.tf$/i)) {
    const content = safeRead(filePath);
    if (content) scanTerraformFile(repoPath, filePath, content, signals);
  }

  for (const filePath of findFilesByName(repoPath, /^template\.ya?ml$/i)) {
    const content = safeRead(filePath);
    if (content) scanCloudFormationFile(repoPath, filePath, content, signals);
  }

  for (const filePath of findFilesByName(repoPath, /^serverless\.ya?ml$/i)) {
    const content = safeRead(filePath);
    if (content) scanServerlessFile(repoPath, filePath, content, signals);
  }

  return signals;
}
