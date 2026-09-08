export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  content: string;
}

function tokenize(content: string): Line[] {
  const lines: Line[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, content: raw.trim() });
  }
  return lines;
}

function stripQuotes(text: string): string {
  const match = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text);
  return match ? match[1] : text;
}

function parseScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (/^\[.*\]$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return stripQuotes(trimmed);
}

/** Casa `key: value` ou `key:` (valor vazio, bloco aninhado abaixo) — nunca em chaves entre aspas
 * com `:` dentro, fora de escopo pro subconjunto de YAML que este parser cobre. */
const MAPPING_KEY = /^([^:]+):\s*(.*)$/;

/** Faz o parse de um bloco cujas linhas-irmãs estão todas na mesma indentação `indent`, a partir de
 * `startIndex`. Retorna o valor e o índice da primeira linha que já não faz parte deste bloco. */
function parseBlock(lines: Line[], startIndex: number, indent: number): [YamlValue, number] {
  if (startIndex >= lines.length || lines[startIndex].indent !== indent) return [null, startIndex];

  if (lines[startIndex].content === "-" || lines[startIndex].content.startsWith("- ")) {
    return parseSequence(lines, startIndex, indent);
  }
  return parseMapping(lines, startIndex, indent);
}

function parseSequence(lines: Line[], startIndex: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = startIndex;
  while (i < lines.length && lines[i].indent === indent && (lines[i].content === "-" || lines[i].content.startsWith("- "))) {
    const rest = lines[i].content === "-" ? "" : lines[i].content.slice(2).trim();

    if (rest === "") {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.indent > indent) {
        const [value, next] = parseBlock(lines, i + 1, nextLine.indent);
        items.push(value);
        i = next;
      } else {
        items.push(null);
        i++;
      }
      continue;
    }

    const keyMatch = MAPPING_KEY.exec(rest);
    if (!keyMatch) {
      items.push(parseScalar(rest));
      i++;
      continue;
    }

    // "- key: value" — o item é um mapeamento cuja primeira chave vem inline com o `-`; as demais
    // chaves do MESMO item (se houver) vêm depois, indentadas 2 a mais que o próprio `-`.
    const map: Record<string, YamlValue> = {};
    const key = stripQuotes(keyMatch[1].trim());
    const rawValue = keyMatch[2];
    i++;
    if (rawValue !== "") {
      map[key] = parseScalar(rawValue);
    } else {
      const nextLine = lines[i];
      if (nextLine && nextLine.indent > indent) {
        const [value, next] = parseBlock(lines, i, nextLine.indent);
        map[key] = value;
        i = next;
      } else {
        map[key] = null;
      }
    }
    if (i < lines.length && lines[i].indent === indent + 2) {
      const [restMap, next] = parseMapping(lines, i, indent + 2);
      Object.assign(map, restMap);
      i = next;
    }
    items.push(map);
  }
  return [items, i];
}

function parseMapping(lines: Line[], startIndex: number, indent: number): [Record<string, YamlValue>, number] {
  const map: Record<string, YamlValue> = {};
  let i = startIndex;
  while (i < lines.length && lines[i].indent === indent) {
    const match = MAPPING_KEY.exec(lines[i].content);
    if (!match) {
      i++;
      continue;
    }
    const key = stripQuotes(match[1].trim());
    const rawValue = match[2];
    if (rawValue !== "") {
      map[key] = parseScalar(rawValue);
      i++;
      continue;
    }
    const nextLine = lines[i + 1];
    if (nextLine && nextLine.indent > indent) {
      const [value, next] = parseBlock(lines, i + 1, nextLine.indent);
      map[key] = value;
      i = next;
    } else {
      map[key] = null;
      i++;
    }
  }
  return [map, i];
}

/**
 * Parser de um SUBCONJUNTO de YAML — mapeamentos e sequências em bloco, escalares (string/número/
 * booleano/null), array inline simples (`[a, b, c]`), aspas simples/duplas. Deliberadamente NÃO
 * suporta âncoras/aliases, multi-documento, mapeamentos flow (`{a: 1}`), escalares multilinha
 * (`|`/`>`) nem comentários no meio de uma linha de valor — suficiente pro estilo que qualquer
 * ferramenta OpenAPI real gera (mesmo espírito minimalista dos outros parsers do projeto: Cargo.toml
 * linha-a-linha, extractOpenApiOperations por indentação fixa). Usado só por
 * `extractContractSchemas` — não substitui o parser de operações (`extractOpenApiOperations`), que
 * continua com sua própria varredura mais simples e já validada.
 */
export function parseMiniYaml(content: string): Record<string, YamlValue> {
  const lines = tokenize(content);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return (value ?? {}) as Record<string, YamlValue>;
}
