# Security Policy

## Supported versions

This project is pre-1.0 (`0.x`). Only the latest release on `master` is supported; there is no
backport policy for older `0.x` versions yet.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Instead, use
[GitHub's private vulnerability reporting](https://github.com/fecuencas/traceability-agent/security/advisories/new)
for this repository, or contact the maintainer directly through the profile linked from
[github.com/fecuencas](https://github.com/fecuencas).

Include, if possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal repository/config that triggers it, if applicable).
- Any suggested fix or mitigation you're aware of.

You should expect an initial response within a few days. This is a small, independently
maintained open source project — there is no formal SLA, but reports are taken seriously and
fixed as quickly as reasonably possible.

## Threat model

`traceability-agent` scans source code from repositories that may not be controlled by whoever
is running the scan (a monorepo with contributions from many people, a decentralized manifest
published by a sibling repository, etc.). Content extracted from those repositories — file
contents, dependency coordinates, resource/topic names found in code, contract fields — is
treated as **untrusted input** and must never be interpreted as executable code or unescaped
markup by this project's own output (Obsidian notes, Mermaid diagrams, the HTML report).

Concretely, this means:

- All untrusted text embedded into the self-contained HTML report is HTML-escaped
  (`src/reports/htmlReport.ts`).
- All untrusted text embedded into a Mermaid diagram label is escaped against Mermaid's own
  quoting rules (`src/obsidian/mermaidRenderer.ts`, `escapeMermaidLabel`) so it cannot break out
  of a label and inject arbitrary diagram syntax (fake nodes/edges, `classDef`, `click`).
- Vault/repo/service/integration ids are validated against a strict allow-list
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) before ever being used to build a filesystem path, and writes
  are checked to stay within the vault directory — this specifically defends against a malicious
  `groupId`/`repoId` (local config or a manifest published by an untrusted sibling repo) attempting
  path traversal.

If you find a case where untrusted repository content ends up unescaped in generated output, or
where a crafted id/manifest can write outside the intended vault directory, that's exactly the
kind of issue this policy wants reported privately first.
