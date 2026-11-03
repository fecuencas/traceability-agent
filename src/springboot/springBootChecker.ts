import fs from "node:fs";
import type { LocalFinding, RepoAnalysisResult } from "../adapters/types.js";
import { walkFiles } from "../adapters/scanUtils.js";
import { parseSpringBootStructure, type ParsedClass, type ParsedSpringBootStructure } from "./springBootStructure.js";

/**
 * Checagens estáticas de wiring do Spring Boot — a causa mais comum, na experiência relatada pelo
 * time que usa este agente, de "funciona na minha máquina" na inicialização: alguém esquece uma
 * anotação (`@SpringBootApplication` na classe principal, `@Configuration` numa classe de `@Bean`s,
 * ou simplesmente cria um `@Service`/`@Component` num pacote que o component-scan não alcança) e o
 * `ApplicationContext` não sobe, ou sobe faltando um bean. Nenhuma das 3 checagens abaixo roda um
 * build nem usa reflection — é a mesma varredura estática (regex/estrutura por linha) que o resto do
 * agente já usa, então elas herdam a mesma limitação: não é uma AST real do compilador, então em
 * caso de dúvida (não achou a classe, scan customizado demais pra resolver) o critério é sempre
 * DEIXAR DE avisar, nunca inventar um achado falso.
 */

const STEREOTYPE_ANNOTATIONS = new Set([
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "Configuration",
  "ControllerAdvice",
  "RestControllerAdvice",
]);

/** As 3 anotações que, juntas na mesma classe, equivalem a `@SpringBootApplication` (é literalmente
 * assim que `@SpringBootApplication` é definida — uma meta-anotação que combina as três). */
const BOOTSTRAP_COMBO = ["Configuration", "EnableAutoConfiguration", "ComponentScan"];

function hasSpringBootDependency(repo: RepoAnalysisResult): boolean {
  return repo.signals.some(
    (signal) => signal.type === "published_artifact_dependency" && signal.target.value.startsWith("org.springframework.boot:"),
  );
}

function findingId(category: string, evidence: { file: string; line: number }): string {
  return `${category}:${evidence.file}:${evidence.line}`;
}

function isBootstrapAnnotated(cls: ParsedClass): boolean {
  const set = new Set(cls.annotations);
  if (set.has("SpringBootApplication")) return true;
  return BOOTSTRAP_COMBO.every((name) => set.has(name));
}

/**
 * Achado A: a classe que sobe o `ApplicationContext` (via `SpringApplication.run(...)` ou
 * `runApplication<...>()`) não tem `@SpringBootApplication` nem a combinação equivalente — o
 * contexto nem inicializa. Só dispara quando a classe referenciada foi efetivamente encontrada no
 * repositório (por nome simples) — se não foi (ex: código gerado, classe em outro módulo não
 * escaneado), não arrisca um falso positivo só por não ter achado.
 */
function checkMissingBootstrapAnnotation(structure: ParsedSpringBootStructure): LocalFinding[] {
  const classesByName = new Map<string, ParsedClass[]>();
  for (const cls of structure.classes) {
    const list = classesByName.get(cls.name) ?? [];
    list.push(cls);
    classesByName.set(cls.name, list);
  }

  const findings: LocalFinding[] = [];
  const reportedEntries = new Set<string>(); // evita duplicar quando o mesmo entry-point é citado 2x (raro, defensivo)
  for (const entry of structure.mainEntries) {
    const candidates = classesByName.get(entry.className);
    if (!candidates || candidates.length === 0) continue;
    // Mais de uma classe com o mesmo nome simples em pacotes diferentes é raro; considera coberto
    // se QUALQUER uma estiver corretamente anotada, pra não arriscar falso positivo num cenário
    // ambíguo que o scanner não tem como resolver direito (nomes simples, sem resolução de import).
    if (candidates.some(isBootstrapAnnotated)) continue;
    const key = `${entry.file}:${entry.line}`;
    if (reportedEntries.has(key)) continue;
    reportedEntries.add(key);
    findings.push({
      id: findingId("spring-boot.missing-bootstrap-annotation", entry),
      severity: "error",
      category: "spring-boot.missing-bootstrap-annotation",
      message:
        `A classe "${entry.className}" sobe o ApplicationContext (SpringApplication.run/runApplication) mas não está ` +
        `anotada com @SpringBootApplication — nem com a combinação equivalente @Configuration + @EnableAutoConfiguration ` +
        `+ @ComponentScan. Sem isso, o contexto do Spring não inicializa.`,
      evidence: { file: entry.file, line: entry.line, snippet: entry.snippet },
      // O ApplicationContext inteiro não sobe — diferente dos outros 2 achados (um @Bean específico
      // faltando, um bean fora do component-scan), este derruba o serviço INTEIRO. Alimenta a
      // cascata de impacto (ver LocalFinding.blocksStartup) pra quem depende deste repositório
      // aparecer impactado, e este repositório aparecer quebrado, nos diagramas/notas.
      blocksStartup: true,
    });
  }
  return findings;
}

/**
 * Achado B: uma classe tem método(s)/função(ões) `@Bean` mas a classe em si não está anotada com
 * `@Configuration` (nem outro estereótipo que o Spring também aceitaria, como `@Component`) — o
 * Spring simplesmente não processa essa classe como fonte de definição de beans, então os métodos
 * `@Bean` nunca são chamados. Inclui também `@Bean` encontrado fora de qualquer classe (função de
 * topo de arquivo em Kotlin), que nunca é processado de jeito nenhum.
 */
function checkBeanWithoutConfiguration(structure: ParsedSpringBootStructure): LocalFinding[] {
  const findings: LocalFinding[] = [];
  for (const cls of structure.classes) {
    if (!cls.hasBeanMethod) continue;
    const hasConfigLike = cls.annotations.some((name) => STEREOTYPE_ANNOTATIONS.has(name));
    if (hasConfigLike) continue;
    const evidence = cls.beanMethodEvidence;
    if (!evidence) continue;
    findings.push({
      id: findingId("spring-boot.bean-method-without-configuration", evidence),
      severity: "error",
      category: "spring-boot.bean-method-without-configuration",
      message:
        `A classe "${cls.name}" tem método(s) @Bean, mas a classe em si não está anotada com @Configuration ` +
        `(nem @Component/@Service/@Repository/...) — o Spring não processa este arquivo como fonte de beans, ` +
        `esses métodos nunca são chamados.`,
      evidence,
    });
  }
  for (const topLevel of structure.topLevelBeans) {
    findings.push({
      id: findingId("spring-boot.bean-method-without-configuration", topLevel),
      severity: "error",
      category: "spring-boot.bean-method-without-configuration",
      message:
        "Função @Bean encontrada fora de qualquer classe — o Spring só processa métodos @Bean dentro de uma " +
        "classe @Configuration; esta função nunca é registrada como bean.",
      evidence: topLevel,
    });
  }
  return findings;
}

const CUSTOM_COMPONENT_SCAN_REGEX = /@(?:ComponentScan|SpringBootApplication)\s*\(/;

/** Repo-wide, best-effort: QUALQUER `@ComponentScan(...)` com argumentos, ou `@SpringBootApplication(...)`
 * com argumentos (pode customizar `scanBasePackages`), em QUALQUER arquivo — sinal de que o escopo
 * real de component-scan pode não ser simplesmente "o pacote da classe @SpringBootApplication"
 * (o único cenário que `checkOutOfScanPackage` sabe resolver com segurança). Encontrar qualquer
 * customização faz a checagem inteira ser pulada pra este repositório, em vez de arriscar um falso
 * positivo tentando adivinhar o que os argumentos configuram. */
function hasCustomizedComponentScan(repoPath: string): boolean {
  const files = walkFiles(repoPath, [".java", ".kt"]);
  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (CUSTOM_COMPONENT_SCAN_REGEX.test(content)) return true;
  }
  return false;
}

function isSubPackageOrSame(pkg: string, root: string): boolean {
  return pkg === root || pkg.startsWith(`${root}.`);
}

/**
 * Achado C: uma classe anotada com um estereótipo (`@Service`, `@Component`, `@Repository`,
 * `@Controller`, `@RestController`, `@Configuration`, ...) mora num pacote que o component-scan
 * padrão do Spring Boot (o pacote da classe `@SpringBootApplication` e seus subpacotes) não alcança
 * — o bean nunca é registrado. Severidade `warning`, não `error`: só roda quando nenhum
 * `@ComponentScan`/`@SpringBootApplication` customizado foi encontrado em lugar nenhum do
 * repositório (ver `hasCustomizedComponentScan`), mas ainda assim depende de resolução por nome de
 * pacote simples — vale menos confiança que as checagens A/B, que são estruturalmente inequívocas.
 */
function checkOutOfScanPackage(structure: ParsedSpringBootStructure, repoPath: string): LocalFinding[] {
  if (hasCustomizedComponentScan(repoPath)) return [];

  const roots = [
    ...new Set(
      structure.classes
        .filter((cls) => cls.annotations.includes("SpringBootApplication"))
        .map((cls) => cls.packageName)
        .filter((pkg) => pkg !== ""),
    ),
  ];
  if (roots.length === 0) return []; // sem classe principal identificada, não há escopo pra comparar contra

  const findings: LocalFinding[] = [];
  for (const cls of structure.classes) {
    if (cls.packageName === "") continue;
    const matchedStereotype = cls.annotations.find((name) => STEREOTYPE_ANNOTATIONS.has(name));
    if (!matchedStereotype) continue;
    if (roots.some((root) => isSubPackageOrSame(cls.packageName, root))) continue;
    findings.push({
      id: findingId("spring-boot.bean-outside-component-scan", cls),
      severity: "warning",
      category: "spring-boot.bean-outside-component-scan",
      message:
        `A classe "${cls.name}" (pacote "${cls.packageName}") está anotada com @${matchedStereotype}, mas fica fora ` +
        `do(s) pacote(s) coberto(s) pelo component-scan padrão do Spring Boot (${roots.map((r) => `"${r}"`).join(", ")}) ` +
        `— pode não ser registrada como bean. Se houver um @ComponentScan customizado cobrindo este pacote, este aviso ` +
        `não se aplica (nenhum foi encontrado no repositório no momento da varredura).`,
      evidence: { file: cls.file, line: cls.line, snippet: `class ${cls.name}` },
    });
  }
  return findings;
}

/**
 * Ponto de entrada: roda as 3 checagens acima para um repositório já analisado. Gated em dois
 * níveis — língua (só Java/Kotlin têm as anotações do Spring) e presença real de uma dependência
 * `org.springframework.boot:*` nos sinais já coletados pelo adapter (evita escanear/parsear
 * arquivos de repositórios Java/Kotlin que nem usam o framework). Chamado centralmente em
 * `adapterRegistry.ts`, igual a `scanInfraSignals` — nenhum adapter de linguagem individual precisa
 * saber que isto existe.
 */
export function checkSpringBootWiring(repoPath: string, repo: RepoAnalysisResult): LocalFinding[] {
  if (repo.language !== "java" && repo.language !== "kotlin") return [];
  if (!hasSpringBootDependency(repo)) return [];

  const structure = parseSpringBootStructure(repoPath);
  return [
    ...checkMissingBootstrapAnnotation(structure),
    ...checkBeanWithoutConfiguration(structure),
    ...checkOutOfScanPackage(structure, repoPath),
  ];
}
