# Como escrever um adapter de linguagem novo

Checklist derivado do padrão real usado pelos 6 adapters já existentes
(`javaMavenAdapter.ts`, `kotlinGradleAdapter.ts`, `nodeNpmAdapter.ts`, `pythonPipAdapter.ts`,
`rubyBundlerAdapter.ts`, `cppCmakeAdapter.ts`). Escrito para servir de checklist direto às próximas
4 linguagens do roadmap (Go, C#/.NET, PHP, Rust — ver plano de Fase 7), mas vale para qualquer
ecossistema futuro.

## 1. Contrato: `LanguageAdapter`

Todo adapter implementa exatamente esta interface (`src/adapters/types.ts`):

```ts
export interface LanguageAdapter {
  id: string;
  matches(repoPath: string): boolean;
  analyze(repoPath: string, repoId: string): RepoAnalysisResult;
}
```

- `matches`: um `fs.existsSync` barato checando o arquivo de manifesto do ecossistema (`pom.xml`,
  `package.json`, `go.mod`, `*.csproj`, `composer.json`, `Cargo.toml`...). Nunca faça parsing pesado
  aqui — só existência de arquivo.
- `analyze`: lê o manifesto pra extrair `coordinates` (identidade do repo pro matching cruzado) e
  roda os scanners de código pra produzir `IntegrationSignal[]`.

## 2. Extrair `coordinates`

`RepoCoordinates = { groupId?, artifactId?, packageName?, version }`. Cada ecossistema usa uma
combinação diferente:
- Maven/Gradle: `groupId` + `artifactId` (chave de matching = `"${groupId}:${artifactId}"`).
- npm/pip/Bundler/CMake/Cargo (pacote com nome único): só `packageName` (chave de matching = o
  próprio nome do pacote/crate/módulo).
- **Importante**: essa `coordinates` é o que `graphBuilder.ts`'s `buildCoordinateIndex` usa pra
  casar um `published_artifact_dependency` de outro repo com este — o valor tem que bater
  EXATAMENTE com o que outro repo declara como dependência dele.

## 3. Sinal de dependência (`published_artifact_dependency`)

Parseie o manifesto pra listar as dependências declaradas (produção + dev, mesmo padrão de
`nodeNpmAdapter` mesclando `dependencies`+`devDependencies` — não vale a pena distinguir, uma
dependência de teste que não resolve pra nenhum repo do grupo simplesmente não vira edge).
`target: { kind: "repo_coordinate", value: <nome-do-pacote> }`, `version` no campo próprio do
signal (não dentro de `target`).

## 4. Sinal de chamada HTTP (`outbound_http`) — via `scanCodePatterns`

```ts
const HTTP_CLIENT_RULES = [
  { detectorId: "<ecossistema>.http-client-scan", type: "outbound_http" as const, regex: /padrão/, confidence: "medium" as const },
];
signals.push(...scanCodePatterns(repoPath, [".ext"], HTTP_CLIENT_RULES));
```

`scanCodePatterns` só resolve pra edge real (`target.kind: "url"`) quando encontra uma URL literal
`http(s)://` **na mesma linha** do regex — é uma limitação de design conhecida (regex de 1 linha,
não segue variável nem faz resolução de config). Quando não acha URL na linha, o sinal ainda é
produzido como `target.kind: "unresolved"` — não vira edge, mas hoje aparece como nó externo
tracejado no ego-graph do repo (`renderEgoGraph`), então não é 100% invisível.

**Regra de ouro contra falso-positivo**: NUNCA use um identificador genérico sozinho
(`\bClient\b`, `\bfetch\(`) se ele coincide com um nome comum de classe/struct/função que o
próprio código do usuário poderia declarar (visto nesta sessão: um stub local `class RestTemplate`
batia no mesmo regex usado pra detectar USO do RestTemplate real). Sempre que possível, exija o
prefixo do módulo/pacote real (`reqwest::get(`, não `get(`; `\GuzzleHttp\Client`, não `Client`).
Os filtros `isCommentOrImportLine`/`isDeclarationOfMatchedIdentifier` (`scanUtils.ts`) já protegem
contra comentário/import/auto-declaração batendo no regex, mas não substituem escolher um regex
específico o bastante.

**Trade-off aceito (visto no adapter PHP)**: exigir o módulo/classe qualificado tem um custo —
como a URL só resolve pra edge real quando está na MESMA linha do marcador, exigir a FQCN completa
(`new \GuzzleHttp\Client(`) só detecta o estilo encadeado numa linha só
(`(new \GuzzleHttp\Client())->get($url)`), não o estilo com variável separada em 2 linhas
(`$client = new Client(); $client->get($url);`, também muito comum). Documente esse gap
explicitamente no adapter em vez de "resolver" afrouxando o regex pra `->get(`/`->post(` sozinho —
isso reintroduziria o mesmo risco de colisão que a exigência de FQCN foi escolhida pra evitar.

## 5. Sinal de fila (`queue_publish`/`queue_consume`) — via `scanTopicPatterns`, opcional

Só faça sentido se o ecossistema tiver uma lib de mensageria comum o bastante (Kafka/SQS/RabbitMQ)
com uma sintaxe de call site que exponha o nome do tópico como **string literal capturável por
regex**. Se a lib real do ecossistema usa builder pattern sem literal numa linha só (ex: Sarama em
Go), documente como gap conhecido em vez de escrever um regex frágil.

## 6. Contrato compartilhado (`contract_reference`) — sempre incluir, é grátis

```ts
signals.push(...scanContractFiles(repoPath, "<ecossistema>.contract-scan"));
```

Já funciona igual pra qualquer linguagem (procura `.proto`/`openapi.yaml`/`swagger.json`/`.avsc`
em qualquer lugar do repo) — não precisa de lógica específica por adapter.

## 7. Registrar

- `src/adapters/adapterRegistry.ts`: importar e adicionar ao array `ADAPTERS`.
- `src/adapters/types.ts`: adicionar a nova entrada em `Language` e `BuildSystem`.
- `src/graph/languageMeta.ts`: adicionar `emoji`/`hexColor` em `LANGUAGE_META` (aparece nos
  diagramas Mermaid e no relatório HTML).

## 8. Testar

Um `src/adapters/<nome>.test.ts` (padrão em `src/adapters/scanUtils.test.ts`): usar
`fs.mkdtempSync` pra criar um repo fixture mínimo, chamar `analyze()` direto, e checar:
- `coordinates` extraídas corretamente do manifesto.
- Dependência declarada vira sinal `published_artifact_dependency`.
- Uma chamada HTTP real (com URL inline) vira `target.kind: "url"`.
- Um comentário/import/declaração do próprio nome do client NÃO produz sinal (o caso que já pegou
  Java/Node nesta sessão).

Depois, crie 1 repo fixture mínimo real em `~/projetos/rePo_testes/` (mesmo padrão dos repos já
existentes) pra validar detecção ponta a ponta antes de considerar a linguagem "suportada de
verdade" — testes unitários sozinhos não pegam problema de integração com o `graphBuilder` real.
