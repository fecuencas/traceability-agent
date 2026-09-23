# Contributing

## Setup

Requires Node.js 18+.

```bash
git clone https://github.com/fecuencas/traceability-agent.git
cd traceability-agent
npm install
```

## Running the tests

```bash
npm test
```

This builds the TypeScript sources (`tsc`) and then runs every `*.test.ts` file colocated with
the module it tests (`src/<area>/<file>.test.ts`) via Node's built-in test runner
(`node --test`, no extra dependency). CI (`.github/workflows/test.yml`) runs the same command on
Node 18.x and 20.x for every push/PR to `master`.

There's no separate lint/typecheck script yet — `npm run build` (which `npm test` runs first) is
a full `tsc` compile, so a type error already fails `npm test` before any test executes.

## Project structure

See the [Project structure](README.md#project-structure) section of the README for a map of
`src/`. In short: one file per MCP tool under `src/tools/`, one analyzer per
language/ecosystem under `src/adapters/`, graph construction and integrity checks under
`src/graph/`, Obsidian vault note generation under `src/obsidian/`, and the standalone CLI under
`src/cli/`.

## Adding a new language adapter

See [`docs/adapter-authoring-guide.md`](docs/adapter-authoring-guide.md).

## Security-sensitive changes

This agent scans source code from repositories it doesn't control, so any change touching how
scanned content (file contents, resource/topic names, dependency coordinates, contract fields)
flows into generated output (HTML report, Mermaid diagrams, Obsidian notes) is security-sensitive.
See [SECURITY.md](SECURITY.md#threat-model) for the threat model, and make sure untrusted text
stays escaped for the output format it lands in — add a regression test alongside the existing
ones in `src/reports/htmlReport.test.ts` / `src/obsidian/mermaidRenderer.test.ts` covering the
new code path.

## Opening a pull request

1. Make sure `npm test` passes locally.
2. Keep the change focused — small, reviewable PRs over large ones mixing unrelated concerns.
3. Follow [SemVer](https://semver.org) intent in your description if the change affects the
   public API/CLI/MCP tool surface (new feature vs. bug fix vs. breaking change), so the version
   bump on release reflects it correctly.
4. Open the PR against `master`. CI must pass (build + tests, Node 18.x and 20.x) before merge.

## Reporting bugs / requesting features

Use [GitHub Issues](https://github.com/fecuencas/traceability-agent/issues). For security
vulnerabilities, see [SECURITY.md](SECURITY.md) instead — please don't file those as public
issues.
