---
name: libpeek
description: >-
  Read the real source code of any npm package at an exact version without
  installing it - list files, glob paths, read files with line numbers, and
  grep contents including .d.ts type definitions, straight from public CDNs.
  Use when the user wants to verify a library's actual exports or API
  signatures before importing it, inspect how a dependency implements
  something, check a package's file layout, confirm version-specific
  behavior, or look up .d.ts type definitions - without npm install, without
  a sandbox, and without executing any third-party code.
---

# libpeek

Read the actual source of npm packages - no install, no sandbox, no execution
of package code. Every command returns JSON; errors are JSON too:
`{"error":true,"code":"...","message":"..."}` - show the message to the user
and stop.

## Prerequisites

Node.js >= 18. Nothing else: the whole tool is one auditable file
(`scripts/libpeek.mjs`) with zero dependencies.

## How to run

Run from this skill's directory (the folder containing this SKILL.md):

```bash
node scripts/libpeek.mjs <command> <package> [args...] [options]
```

## Commands

| Command | Example |
| ------- | ------- |
| `list <pkg>` | `node scripts/libpeek.mjs list react` |
| `glob <pkg> <patterns...>` | `node scripts/libpeek.mjs glob lucide-react arrow-left` (fuzzy) or `node scripts/libpeek.mjs glob zod "dist/**/*.d.ts"` (wildcards) |
| `read <pkg> <path>` | `node scripts/libpeek.mjs read react package.json` |
| `grep <pkg> <pattern>` | `node scripts/libpeek.mjs grep zod exports --include package.json` |

Version resolution (do not over-specify it):

1. Explicit `pkg@version` or `--version` - exact version, dist-tag, or semver range
2. Otherwise the version declared in the **user's project package.json** (dependencies / devDependencies)
3. Otherwise `latest`

So for packages already in the user's manifest, omit the version - results
stay aligned with what is actually installed. The inline form works
everywhere: `read react@19.1.0 dist/index.js`.

## Workflow

1. Before importing an unfamiliar API: `glob <pkg> "*.d.ts"`, then `read`
   the matching declaration file. Verify real exports and signatures
   instead of trusting memory.
2. File layout unknown? `list` or `glob` first, then `read` / `grep`.
3. `grep` searches file contents; to find a file or export by name use
   `glob` - it supports fuzzy file-name matching (e.g. an icon in lucide).
4. Notable output fields: `read` returns `content` with line numbers and
   `truncated` - continue with `--offset`. `grep` may set `hint` - read it
   and follow it; it usually means `--include` matched no files and you
   should `glob` first.

## Large package strategy

- `grep` downloads at most 30 files per call. On icon/doc-heavy packages
  always pass `--include` (e.g. `--include "dist/**/*.d.ts"`).
- `read` caps at 2000 lines / 50 KB per call; page through with `--offset`.
- `list` on huge packages returns thousands of paths - prefer `glob`.

## Safety

Read-only HTTP against public CDNs (unpkg / jsDelivr; `--mirror cn` prefers
npmmirror for China). Zero dependencies, no eval, no shell, no package code
execution - safe in untrusted repos by design. Threat model:
references/security.md. Full option reference and error codes:
references/usage.md.
