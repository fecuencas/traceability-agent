# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
intends to adhere to [Semantic Versioning](https://semver.org/) once it reaches `1.0.0`. Before
that, breaking changes may land within the `0.x` line.

## [Unreleased]

### Added

- `LICENSE` (MIT) and an explicit License section in the README.
- CI (`.github/workflows/test.yml`): runs `npm test` on Node 18.x and 20.x for every push/PR to
  `master`, with a status badge in the README.
- `SECURITY.md` describing the threat model (scanned repository content is untrusted input) and
  how to report a vulnerability.
- `CONTRIBUTING.md` with setup, test, and PR guidelines.
- `license`, `repository`, `bugs`, `homepage`, and `engines.node` fields in `package.json`.
- Regression tests for Mermaid-label and HTML-report escaping of untrusted, repository-sourced
  content (topic/queue names, dependency versions, artifact coordinates, contract-break reasons).
- **Spring Boot wiring checks** (`src/springboot/`): a new category of *local* finding (scoped to
  one repository, not a cross-repo integration) for Java/Kotlin repos that depend on
  `org.springframework.boot:*`. Three checks, all static (no build/reflection): (1) the class that
  calls `SpringApplication.run()`/`runApplication()` is missing `@SpringBootApplication` (or the
  equivalent `@Configuration`+`@EnableAutoConfiguration`+`@ComponentScan` combo); (2) a class has
  `@Bean` methods but isn't itself `@Configuration`-or-equivalent, so Spring never processes it as
  a bean source; (3) a `@Service`/`@Component`/... class sits in a package the default
  component-scan doesn't reach. Surfaced in the repo's Obsidian note (its own block) and in the
  HTML report (its own section + stat tiles; `error`-severity findings count toward the top status
  pill). New type `RepoAnalysisResult.localFindings` (`src/adapters/types.ts`) carries this
  generically — the mechanism isn't Spring-specific, just today's only consumer of it.
- **Local findings can now cascade like a broken integration.** A `LocalFinding` with
  `blocksStartup: true` (today: only the missing-`@SpringBootApplication` check — the one case
  where the whole service provably never starts) feeds the same cascading-impact engine a
  broken/removed edge already triggers (`applyCascadingImpact`'s new `brokenRepoIds` parameter,
  `graph/cascadeImpact.ts`): the repo itself renders `broken` (red) in every diagram and note, and
  everything that actively depends on it (HTTP callers, artifact/contract dependents) or that it
  actively feeds (queues it publishes to) renders `impacted` (orange) — all without a single graph
  edge ever changing status on its own. `analyze_impact`'s blast radius picks this up too.
- **Per-repository file name for the vault note**, independent of `repoId` (`repos[].displayName`,
  or group-level `maxRepoNameLength` for automatic truncation+hash-suffix — see the README's
  "Shortening long repo names" section). Fixes long/corporate-convention repo names turning into
  oversized, hard-to-read labels in Obsidian's *native* Graph View, which always labels a node by
  its file name and has no truncation setting of its own. Mermaid diagrams (notes, HTML report)
  are untouched by this — they always show the full `repoId`, by design.
- **Per-integration-type emoji** (📦 artifact dependency, 🔌 HTTP call, 📤/📥 queue publish/consume,
  📄 contract reference, ⚙️ configured endpoint, 🏷️ infra ownership — `EDGE_LABELS` in
  `graph/edgeLabels.ts`) on every edge label: Mermaid diagram edges, the HTML report's type chip,
  and the textual integration lists in Obsidian notes. Previously only queue/infra *nodes* had an
  icon of their own; a direct HTTP call or contract reference (no queue in between) was a plain,
  undifferentiated line.

### Fixed

- A pluralization bug in the repo note's risk-summary header: `"${count} integração${count > 1 ?
  "ões" : ""}"` produced the literal string "integraçãoões" for more than one impacting
  integration, instead of "integrações".
- **Security:** `npm audit` (run as part of pushing this release) turned up 12 new advisories
  disclosed against transitive/direct dependencies since the last dependency bump, 2 of them
  critical (including a DOMPurify XSS bypass — notably the same sanitizer the Mermaid
  `securityLevel: "strict"` setting relies on) and 4 high, several in `@modelcontextprotocol/sdk`
  itself (OAuth/bearer-auth and request-size-limit issues in its HTTP transport). All 10
  semver-compatible fixes applied via `npm audit fix` (`package.json` ranges unchanged — only
  `package-lock.json` resolutions moved, `@modelcontextprotocol/sdk` 1.30.0→1.32.2, `zod`
  →4.6.7). One remaining low-severity advisory (`katex`, pulled in by `mermaid`) still requires
  the `mermaid` 11→12 major bump already declined earlier for an unrelated high-severity issue in
  that line (`chevrotain`→`lodash-es`) — tracked, not fixed in this release.
- CI (`.github/workflows/test.yml`) only triggered on pushes/PRs to `master`. The repository's
  default branch had since been renamed to `main` on GitHub (via web-UI-created commits for the
  issue/PR templates and code of conduct, which never reached any local clone) — so `test`/
  `security`, the exact checks branch protection on `main` requires before merging, had never
  actually run there. Triggers updated to `main`; `CONTRIBUTING.md`/`SECURITY.md` updated to match.

- **Security:** untrusted text sourced from a scanned repository (queue/topic names, dependency
  versions, artifact coordinates) was interpolated into Mermaid diagram labels without escaping
  quotes. A crafted value could break out of its label and inject arbitrary Mermaid syntax (fake
  nodes/edges, `classDef`, `click`) into the generated graph — a graph-integrity/spoofing issue,
  since this tool exists specifically to be a trustworthy source of truth for cross-repo
  integrations. Fixed by escaping every such value before it's placed inside a quoted Mermaid
  label (`escapeMermaidLabel` in `src/obsidian/mermaidRenderer.ts`).
- `npm test`'s reliance on a `dist/**/*.test.js` glob only worked on shells with globstar enabled
  (e.g. the author's local `zsh`); it silently failed to find any test file under `bash` on Node
  versions without native glob support in `node --test`, which is what the new CI runs on.
  Replaced with `find | xargs`, portable across shells and Node 18+.

## [0.1.0]

Initial implementation: MCP server for cross-repository integration mapping, contract-breakage
detection, impact analysis, and Obsidian vault / HTML report generation. See the README for the
full feature set as of this version.
