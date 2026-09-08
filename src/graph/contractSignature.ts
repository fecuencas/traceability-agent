import { parseMiniYaml } from "./miniYaml.js";
import type { YamlValue } from "./miniYaml.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * Extrai o conjunto de operações (`"MÉTODO /caminho"`) declaradas no bloco `paths:` de um OpenAPI
 * em YAML — parser mínimo por indentação (nível 0 = `paths:`, nível 2 = path, nível 4 = método),
 * suficiente pro formato padrão gerado por qualquer ferramenta OpenAPI, sem precisar de uma
 * dependência de parser YAML completo (mesmo espírito do parser linha-a-linha do Cargo.toml).
 * Limitação conhecida: só reconhece o método em estilo bloco (`get:` sozinho na linha, valor no
 * bloco indentado abaixo); YAML flow-style na mesma linha (`get: {summary: x}`) não bate no regex
 * e a operação some da extração — não é um problema prático pro formato que qualquer gerador
 * OpenAPI real produz (sempre bloco), mas pode subestimar o conjunto de operações de um arquivo
 * escrito à mão nesse estilo.
 */
export function extractOpenApiOperations(content: string): Set<string> {
  const operations = new Set<string>();
  let inPaths = false;
  let currentPath: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\S/.test(rawLine)) {
      inPaths = /^paths:\s*$/.test(rawLine);
      currentPath = null;
      continue;
    }
    if (!inPaths) continue;

    const pathMatch = /^ {2}(\S.*):\s*$/.exec(rawLine);
    if (pathMatch) {
      currentPath = pathMatch[1].trim();
      continue;
    }

    const methodMatch = /^ {4}(\w+):\s*$/.exec(rawLine);
    if (methodMatch && currentPath && HTTP_METHODS.has(methodMatch[1].toLowerCase())) {
      operations.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }
  return operations;
}

/** Mesma extração que `extractOpenApiOperations`, pra um `swagger.json` — JSON é estruturado, não
 * precisa de parser próprio, só `JSON.parse` direto. */
export function extractSwaggerJsonOperations(content: string): Set<string> {
  const operations = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return operations;
  }
  const paths = (parsed as { paths?: Record<string, unknown> })?.paths ?? {};
  for (const [pathKey, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of Object.keys(methods)) {
      if (HTTP_METHODS.has(method.toLowerCase())) operations.add(`${method.toUpperCase()} ${pathKey}`);
    }
  }
  return operations;
}

/**
 * Ponto de entrada único: decide o extrator pelo nome do arquivo. Retorna `undefined` (sem
 * conjunto de operações) para `.proto`/`.avsc` — de propósito: extrair campo/número de campo de
 * Protobuf ou schema Avro de forma confiável sem uma dependência de parser dedicada tem risco real
 * de falso-positivo (ex: um comentário ou um `oneof`/`reserved` mal interpretado como campo
 * removido), e o custo de errar aqui é alto (marcaria uma integração saudável como quebrada). Por
 * enquanto esses dois formatos continuam só com a detecção de presença/remoção do arquivo em si
 * (mecanismo genérico de `removed`, sem diff estrutural do conteúdo).
 */
export function extractContractOperations(fileName: string, content: string): Set<string> | undefined {
  if (/openapi\.ya?ml$/i.test(fileName)) return extractOpenApiOperations(content);
  if (/swagger\.json$/i.test(fileName)) return extractSwaggerJsonOperations(content);
  return undefined;
}

/** Assinatura de UM campo de UM schema em `components.schemas` — o suficiente pra saber se dois
 * lados "falam da mesma forma" sobre esse campo: mesmo tipo, mesma obrigatoriedade, mesmas
 * restrições de valor. */
export interface ContractFieldSignature {
  schema: string;
  field: string;
  /** "string" | "integer" | "number" | "boolean" | "array" | "object", ou "ref:NomeDoSchema" quando
   * o campo é `$ref` direto (objeto aninhado referenciado, não resolvido recursivamente — evita
   * loop em schemas que se referenciam entre si e mantém o escopo em "este schema mudou", não
   * "qualquer schema que ele referencia mudou"). */
  type?: string;
  required: boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
  /** Só quando `type === "array"`: tipo do item (mesmo vocabulário de `type`, incluindo "ref:X"). */
  itemsType?: string;
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, YamlValue>) : {};
}

function buildFieldSignature(schemaName: string, fieldName: string, fieldDef: Record<string, YamlValue>, required: boolean): ContractFieldSignature {
  const signature: ContractFieldSignature = { schema: schemaName, field: fieldName, required };
  const ref = fieldDef.$ref;
  if (typeof ref === "string") {
    signature.type = `ref:${refName(ref)}`;
  } else if (typeof fieldDef.type === "string") {
    signature.type = fieldDef.type;
  }
  if (typeof fieldDef.format === "string") signature.format = fieldDef.format;
  if (typeof fieldDef.minLength === "number") signature.minLength = fieldDef.minLength;
  if (typeof fieldDef.maxLength === "number") signature.maxLength = fieldDef.maxLength;
  if (typeof fieldDef.pattern === "string") signature.pattern = fieldDef.pattern;
  if (typeof fieldDef.minimum === "number") signature.minimum = fieldDef.minimum;
  if (typeof fieldDef.maximum === "number") signature.maximum = fieldDef.maximum;
  if (Array.isArray(fieldDef.enum)) signature.enumValues = fieldDef.enum.map(String).sort();
  if (fieldDef.type === "array") {
    const items = asRecord(fieldDef.items);
    if (typeof items.$ref === "string") signature.itemsType = `ref:${refName(items.$ref)}`;
    else if (typeof items.type === "string") signature.itemsType = items.type;
  }
  return signature;
}

/** Navega `components.schemas.<Nome>.properties.<campo>` de uma árvore já parseada (mini-YAML ou
 * JSON) e monta uma assinatura por campo, chaveada por `"<Schema>.<campo>"`. */
function extractFieldSignatures(tree: Record<string, YamlValue>): Map<string, ContractFieldSignature> {
  const signatures = new Map<string, ContractFieldSignature>();
  const schemas = asRecord(asRecord(tree.components).schemas);
  for (const [schemaName, schemaDefRaw] of Object.entries(schemas)) {
    const schemaDef = asRecord(schemaDefRaw);
    const requiredList = Array.isArray(schemaDef.required) ? schemaDef.required.map(String) : [];
    const properties = asRecord(schemaDef.properties);
    for (const [fieldName, fieldDefRaw] of Object.entries(properties)) {
      const key = `${schemaName}.${fieldName}`;
      signatures.set(key, buildFieldSignature(schemaName, fieldName, asRecord(fieldDefRaw), requiredList.includes(fieldName)));
    }
  }
  return signatures;
}

/**
 * Extrai a assinatura de campo-a-campo de `components.schemas` — usada pra checar se dois lados de
 * uma integração "ainda falam da mesma forma" sobre o contrato (tipo, obrigatoriedade, restrições),
 * não só se as mesmas operações existem. Mesma decisão de escopo de `extractContractOperations`:
 * só openapi.yaml/yml e swagger.json, `.proto`/`.avsc` retornam `undefined` (fora de escopo, ver
 * motivo no comentário de `extractContractOperations`).
 */
export function extractContractSchemas(fileName: string, content: string): Map<string, ContractFieldSignature> | undefined {
  if (/openapi\.ya?ml$/i.test(fileName)) return extractFieldSignatures(parseMiniYaml(content));
  if (/swagger\.json$/i.test(fileName)) {
    try {
      return extractFieldSignatures(JSON.parse(content) as Record<string, YamlValue>);
    } catch {
      return new Map();
    }
  }
  return undefined;
}

/** Nomes dos atributos comparáveis de uma assinatura — usado tanto por `diffFieldAttributes`
 * (decide quais atributos divergem entre dois lados) quanto por `serializeFieldSignatureWithHighlight`
 * (decide quais destacar). Mantido num só lugar pra nunca dessincronizar. */
export type FieldSignatureAttribute = "type" | "required" | "format" | "minLength" | "maxLength" | "pattern" | "minimum" | "maximum" | "enum" | "itemsType";

/** Delimitadores invisíveis (caracteres de controle, nunca aparecem em YAML/JSON reais) que marcam
 * o trecho de `serializeFieldSignatureWithHighlight` que diverge entre os dois lados — cada
 * renderizador (nota do Obsidian, relatório HTML) substitui esses marcadores pelo destaque no seu
 * próprio formato (span colorido inline vs `<span class="...">`), depois de já ter escapado o
 * resto do texto — nunca antes, pra não arriscar interpretar HTML vindo do conteúdo do contrato. */
export const DIFF_HIGHLIGHT_START = "";
export const DIFF_HIGHLIGHT_END = "";

/** Serializa uma assinatura de campo numa string curta e determinística — usada tanto pra exibir
 * "o que o campo diz hoje" quanto como valor de comparação (diff textual simples, sem precisar
 * reimplementar igualdade estrutural). */
export function serializeFieldSignature(signature: ContractFieldSignature): string {
  return serializeFieldSignatureWithHighlight(signature, new Set());
}

/** Mesma serialização de `serializeFieldSignature`, mas envolve o segmento `atributo=valor` de
 * cada atributo em `highlightAttributes` com `DIFF_HIGHLIGHT_START`/`END` — usado por
 * `diffSchemasBetweenRepos` pra destacar só o atributo que realmente diverge entre os dois lados,
 * em vez da linha inteira. */
export function serializeFieldSignatureWithHighlight(
  signature: ContractFieldSignature,
  highlightAttributes: Set<FieldSignatureAttribute>,
): string {
  const wrap = (attribute: FieldSignatureAttribute, text: string): string =>
    highlightAttributes.has(attribute) ? `${DIFF_HIGHLIGHT_START}${text}${DIFF_HIGHLIGHT_END}` : text;

  const parts = [wrap("type", `type=${signature.type ?? "?"}`), wrap("required", `required=${signature.required}`)];
  if (signature.format !== undefined) parts.push(wrap("format", `format=${signature.format}`));
  if (signature.minLength !== undefined) parts.push(wrap("minLength", `minLength=${signature.minLength}`));
  if (signature.maxLength !== undefined) parts.push(wrap("maxLength", `maxLength=${signature.maxLength}`));
  if (signature.pattern !== undefined) parts.push(wrap("pattern", `pattern=${signature.pattern}`));
  if (signature.minimum !== undefined) parts.push(wrap("minimum", `minimum=${signature.minimum}`));
  if (signature.maximum !== undefined) parts.push(wrap("maximum", `maximum=${signature.maximum}`));
  if (signature.enumValues?.length) parts.push(wrap("enum", `enum=[${signature.enumValues.join(",")}]`));
  if (signature.itemsType !== undefined) parts.push(wrap("itemsType", `itemsType=${signature.itemsType}`));
  return parts.join(";");
}

/** Compara duas assinaturas do MESMO campo e retorna quais atributos divergem — usado pra destacar
 * só o que realmente mudou (ex: só `type`), não o campo inteiro. */
export function diffFieldAttributes(a: ContractFieldSignature, b: ContractFieldSignature): Set<FieldSignatureAttribute> {
  const diffs = new Set<FieldSignatureAttribute>();
  if (a.type !== b.type) diffs.add("type");
  if (a.required !== b.required) diffs.add("required");
  if (a.format !== b.format) diffs.add("format");
  if (a.minLength !== b.minLength) diffs.add("minLength");
  if (a.maxLength !== b.maxLength) diffs.add("maxLength");
  if (a.pattern !== b.pattern) diffs.add("pattern");
  if (a.minimum !== b.minimum) diffs.add("minimum");
  if (a.maximum !== b.maximum) diffs.add("maximum");
  if ((a.enumValues ?? []).join(",") !== (b.enumValues ?? []).join(",")) diffs.add("enum");
  if (a.itemsType !== b.itemsType) diffs.add("itemsType");
  return diffs;
}
