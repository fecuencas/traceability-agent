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

### Fixed

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
