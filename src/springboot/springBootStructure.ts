import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "../adapters/scanUtils.js";

/**
 * Uma declaração de classe (Java `class`/Kotlin `class`) encontrada em algum arquivo do repositório,
 * com as anotações que a precedem diretamente — é o bloco de construção de todas as checagens de
 * wiring do Spring Boot (ver `springBootChecker.ts`). Não é uma AST real: é um scanner sequencial
 * por linha, pensado pro formato em que código Java/Kotlin real é escrito (anotação(ões) direto
 * acima da declaração que anotam, um `{` relativamente perto do `class Nome`) — não lida com código
 * deliberadamente ofuscado/condensado numa linha só fora do comum.
 */
export interface ParsedClass {
  /** Nome simples da classe (sem pacote). */
  name: string;
  /** Pacote declarado no topo do arquivo (`package a.b.c;`), ou "" se nenhum foi encontrado. */
  packageName: string;
  /** Nomes das anotações que precedem a declaração, sem o `@` nem os argumentos (ex: "Service",
   * "RequestMapping") — repetidas se a mesma anotação aparecer mais de uma vez (incomum, mas não
   * vale a pena filtrar). */
  annotations: string[];
  file: string;
  line: number;
  /** true se ao menos um método/função `@Bean` foi encontrado como membro DIRETO desta classe (não
   * de uma classe aninhada dentro dela). */
  hasBeanMethod: boolean;
  /** Evidência do primeiro método `@Bean` encontrado nesta classe — só presente quando
   * `hasBeanMethod` é true. */
  beanMethodEvidence?: { file: string; line: number; snippet: string };
}

/** Uma chamada que sobe o `ApplicationContext` do Spring Boot: `SpringApplication.run(Foo.class,
 * args)` (Java) ou `SpringApplication.run(Foo::class.java, args)` / `runApplication<Foo>(args)`
 * (Kotlin). `className` é sempre o nome SIMPLES da classe referenciada (qualificação de pacote, se
 * presente, é descartada — resolver por nome simples contra `ParsedClass.name` é suficiente pro caso
 * real: duas classes de mesmo nome simples ambas candidatas a "a classe principal" no mesmo
 * repositório é cenário patológico demais pra valer a pena resolver certinho aqui). */
export interface MainEntryRef {
  className: string;
  file: string;
  line: number;
  snippet: string;
}

/** `@Bean` encontrado fora de qualquer classe (nível de topo de um arquivo Kotlin) — Spring nunca
 * processa isso como definição de bean (não existe um `@Configuration` dono), então é sinalizado
 * diretamente em vez de tentar (incorretamente) atribuí-lo a alguma classe. */
export interface TopLevelBeanRef {
  file: string;
  line: number;
  snippet: string;
}

export interface ParsedSpringBootStructure {
  classes: ParsedClass[];
  mainEntries: MainEntryRef[];
  topLevelBeans: TopLevelBeanRef[];
}

const RUN_APPLICATION_REGEX = /\bSpringApplication\s*\.\s*run\s*\(\s*([A-Za-z_][\w.]*)/;
const KOTLIN_RUN_APPLICATION_REGEX = /\brunApplication\s*<\s*([A-Za-z_][\w.]*)\s*>/;

const CLASS_DECL_REGEX =
  /^(?:(?:public|private|protected|internal|static|final|abstract|open|sealed|data|inner|enum)\s+)*class\s+([A-Za-z_]\w*)/;

/** `SpringApplication.run(X.class, ...)`/`SpringApplication.run(com.example.X.class, ...)` capturam
 * o caminho pontilhado INTEIRO, incluindo o sufixo `.class` do Java — que, visto só como mais um
 * segmento separado por ponto, ficaria por último e seria confundido com o nome da classe (ex:
 * capturando literalmente `"class"` em vez de `"X"`). Remove esse sufixo primeiro, só depois pega o
 * último segmento (que é o nome simples tanto no caso qualificado `com.example.X` quanto no caso
 * direto `X`, já sem o sufixo). */
function extractSimpleClassName(rawRef: string): string | undefined {
  const withoutClassSuffix = rawRef.endsWith(".class") ? rawRef.slice(0, -".class".length) : rawRef;
  const segments = withoutClassSuffix.split(".").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/**
 * Varre `text` caractere a caractere contando `(`/`)` e `{`/`}`, ignorando qualquer um deles que
 * esteja DENTRO de um literal de string (`"..."`, com `\"` escapado). Sem isso, qualquer anotação
 * comum em código Spring real com um valor de string contendo parênteses ou chaves — ex:
 * `@Value("${some.config:(default)}")`, `@RequestMapping("/orders/{id}")` — derruba o balanço de
 * parênteses/chaves calculado ingenuamente (`str.split("(").length`), fazendo o parser achar que uma
 * anotação de uma linha só continua na próxima, ou errar a profundidade de bloco. Não lida com
 * literais de caractere Java (`'('`) nem text blocks (`"""`) — ambos raros em anotações reais o
 * bastante pra não valer a pena cobrir agora; na pior hipótese esta função super ou subestima o
 * balanço nesses casos raros, e o parser já é desenhado pra falhar "seguro" (deixar de detectar uma
 * classe) nesse cenário, nunca pra inventar um achado falso.
 */
function scanDelta(text: string): { parenDelta: number; braceOpens: number; braceCloses: number } {
  let parenDelta = 0;
  let braceOpens = 0;
  let braceCloses = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++; // pula o próximo char (escape) sem interpretá-lo
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "(") {
      parenDelta++;
    } else if (ch === ")") {
      parenDelta--;
    } else if (ch === "{") {
      braceOpens++;
    } else if (ch === "}") {
      braceCloses++;
    }
  }
  return { parenDelta, braceOpens, braceCloses };
}

/** Extrai o nome da(s) anotação(ões) no COMEÇO de uma linha (ex: `"@Service"` -> `["Service"]`,
 * `"@Service @Primary"` -> `["Service", "Primary"]`) e o restante da linha depois delas, parando na
 * primeira anotação cujos parênteses não fecham nesta mesma linha (continua na próxima — ver
 * `pendingParenBalance` em `parseFile`). Não tenta resolver anotações no MEIO/fim de uma linha sem
 * relação com elas (ex: a palavra "@Service" dentro de um comentário) — só o prefixo, que é onde
 * anotações de declaração sempre ficam. */
function stripLeadingAnnotations(line: string): { names: string[]; rest: string; openParenBalance: number } {
  const names: string[] = [];
  let rest = line;
  for (;;) {
    const nameMatch = /^@([A-Za-z_]\w*)/.exec(rest);
    if (!nameMatch) break;
    names.push(nameMatch[1]);
    rest = rest.slice(nameMatch[0].length);
    const afterParenMatch = /^\s*\(/.exec(rest);
    if (!afterParenMatch) {
      rest = rest.trimStart();
      continue; // anotação sem argumentos (ex: `@Service`) — segue pra próxima anotação, se houver
    }
    // Anotação COM argumentos: acha o `)` que fecha, ciente de string literal, podendo não existir
    // nesta linha (aí os argumentos continuam na próxima).
    let depth = 0;
    let inString = false;
    let closeIndex = -1;
    const startIndex = line.length - rest.length; // posição absoluta do `(` em `rest`
    for (let i = startIndex; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          closeIndex = i;
          break;
        }
      }
    }
    if (closeIndex === -1) {
      // Parênteses não fecham nesta linha — balanço restante (sempre >=1 aqui) informado ao chamador.
      return { names, rest: "", openParenBalance: depth };
    }
    rest = line.slice(closeIndex + 1).trimStart();
  }
  return { names, rest: rest.trim(), openParenBalance: 0 };
}

function parseFile(
  filePath: string,
  repoPath: string,
): { classes: ParsedClass[]; mainEntries: MainEntryRef[]; topLevelBeans: TopLevelBeanRef[] } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { classes: [], mainEntries: [], topLevelBeans: [] };
  }
  const relFile = path.relative(repoPath, filePath);
  const packageMatch = /^\s*package\s+([\w.]+)\s*;?\s*$/m.exec(content);
  const packageName = packageMatch ? packageMatch[1] : "";

  const classes: ParsedClass[] = [];
  const mainEntries: MainEntryRef[] = [];
  const topLevelBeans: TopLevelBeanRef[] = [];

  // Pilha de classes cuja declaração já foi vista mas cujo corpo (`{`) ainda não fechou — o topo é a
  // classe "ativa" no ponto atual do arquivo (onde um `@Bean` encontrado agora seria membro dela, se
  // for membro direto). `bodyDepth` é o valor de `depth` IMEDIATAMENTE DEPOIS do `{` de abertura dela
  // — quando `depth` cai abaixo disso, o corpo dela fechou, sai da pilha.
  const classStack: { parsed: ParsedClass; bodyDepth: number; awaitingOpenBrace: boolean }[] = [];
  let depth = 0;
  let pendingAnnotations: string[] = [];
  let pendingParenBalance = 0;

  const applyDepth = (text: string): void => {
    const { braceOpens, braceCloses } = scanDelta(text);
    for (let k = 0; k < braceOpens; k++) {
      depth++;
      const top = classStack[classStack.length - 1];
      if (top?.awaitingOpenBrace) {
        top.awaitingOpenBrace = false;
        top.bodyDepth = depth;
      }
    }
    for (let k = 0; k < braceCloses; k++) {
      depth--;
      while (classStack.length > 0 && depth < classStack[classStack.length - 1].bodyDepth) {
        classStack.pop();
      }
    }
  };

  const processDeclarationLine = (text: string, declLineNo: number): void => {
    const classMatch = CLASS_DECL_REGEX.exec(text);
    if (classMatch) {
      const parsed: ParsedClass = {
        name: classMatch[1],
        packageName,
        annotations: pendingAnnotations,
        file: relFile,
        line: declLineNo,
        hasBeanMethod: false,
      };
      classes.push(parsed);
      classStack.push({ parsed, bodyDepth: -1, awaitingOpenBrace: true });
      pendingAnnotations = [];
    } else {
      // Não é uma declaração de classe — se as anotações pendentes incluem `@Bean`, isto é um
      // método/função `@Bean`. Atribui à classe ativa (topo da pilha); sem nenhuma classe ativa, é
      // um `@Bean` de topo de arquivo (Kotlin), que o Spring nunca processa.
      if (pendingAnnotations.includes("Bean")) {
        const top = classStack[classStack.length - 1];
        if (top) {
          if (!top.parsed.hasBeanMethod) {
            top.parsed.hasBeanMethod = true;
            top.parsed.beanMethodEvidence = { file: relFile, line: declLineNo, snippet: text };
          }
        } else {
          topLevelBeans.push({ file: relFile, line: declLineNo, snippet: text });
        }
      }
      pendingAnnotations = [];
    }
    applyDepth(text);
  };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();

    // `SpringApplication.run(...)`/`runApplication<...>()` são procurados em TODA linha, independente
    // de anotação/classe/profundidade — é só uma chamada de método, não uma declaração.
    const runMatch = RUN_APPLICATION_REGEX.exec(trimmed) ?? KOTLIN_RUN_APPLICATION_REGEX.exec(trimmed);
    if (runMatch) {
      const simpleName = extractSimpleClassName(runMatch[1]);
      if (simpleName) mainEntries.push({ className: simpleName, file: relFile, line: lineNo, snippet: trimmed });
    }

    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      // Linha em branco/comentário: transparente — não consome nem limpa o buffer de anotações pendentes.
      continue;
    }

    if (pendingParenBalance > 0) {
      // Continuação dos argumentos de uma anotação multi-linha — os `(`/`)`/`{`/`}` aqui dentro (ex:
      // array literal `{"a","b"}`) não são estrutura de código, ignorados pra profundidade.
      pendingParenBalance += scanDelta(trimmed).parenDelta;
      continue;
    }

    if (trimmed.startsWith("@")) {
      const { names, rest, openParenBalance } = stripLeadingAnnotations(trimmed);
      pendingAnnotations.push(...names);
      if (openParenBalance > 0) {
        pendingParenBalance = openParenBalance;
        continue;
      }
      if (rest === "") continue; // linha era só anotação(ões), nada mais a processar aqui
      // `rest` sobrou algo na mesma linha (ex: `@Service class Foo {`) — processa como se fosse a
      // própria linha (anotações já extraídas, não precisa re-detectar).
      processDeclarationLine(rest, lineNo);
      continue;
    }

    processDeclarationLine(trimmed, lineNo);
  }

  return { classes, mainEntries, topLevelBeans };
}

/** Escaneia todos os arquivos `.java`/`.kt` do repositório e monta a estrutura usada pelas checagens
 * de wiring do Spring Boot. Custo proporcional ao tamanho do repositório (mesma varredura de
 * arquivos que `scanCodePatterns`/`scanTopicPatterns` já fazem pros outros detectores) — chamado uma
 * única vez por `checkSpringBootWiring` e reaproveitado entre as 3 checagens. */
export function parseSpringBootStructure(repoPath: string): ParsedSpringBootStructure {
  const files = walkFiles(repoPath, [".java", ".kt"]);
  const classes: ParsedClass[] = [];
  const mainEntries: MainEntryRef[] = [];
  const topLevelBeans: TopLevelBeanRef[] = [];
  for (const filePath of files) {
    const parsed = parseFile(filePath, repoPath);
    classes.push(...parsed.classes);
    mainEntries.push(...parsed.mainEntries);
    topLevelBeans.push(...parsed.topLevelBeans);
  }
  return { classes, mainEntries, topLevelBeans };
}
