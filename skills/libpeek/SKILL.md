---
name: libpeek
description: >-
  Browse any npm package like a local node_modules: its real source code at
  the version you specify, without installing it and without executing any
  third-party code. Use when the user wants to verify a
  library's actual exports or API signatures before importing it, inspect
  how a dependency implements something, check a package's file layout,
  confirm version-specific behavior, or look up .d.ts type definitions -
  straight from the source, not from docs or training-data memory.
  Complements doc-lookup tools (context7 and similar): those serve generated
  documentation, libpeek serves source-code facts.
---

# libpeek

Read the actual source of npm packages - no install, no sandbox, no execution
of package code. Every tool call returns JSON. Expected failures return
`{"error":true,"code":"...","message":"..."}` - they are actionable (retry
network errors, glob to find a real path, narrow include) - keep going
instead of stopping; only `internal` errors are bugs - show those to the
user and stop.

Doc-lookup tools (context7 and similar) serve generated or curated
documentation. libpeek serves source-code facts: the real code of the
version you pin. They complement each other - reach for libpeek when
docs may lag behind a release, cover only part of the API, or when the
question is "what does the code actually do".

## Prerequisites

Node.js >= 18. Nothing else to install.

## How to run

Run from this skill's directory (the folder containing this SKILL.md).
Positional form for quick calls, JSON form for full arguments (same shape as
MCP tool calls):

```bash
node scripts/index.mjs list react
node scripts/index.mjs read react package.json
node scripts/index.mjs glob lucide-react arrow-left
node scripts/index.mjs grep '{"package":"zod","pattern":"exports","include":"package.json"}'
```

## Tools

| Tool | JSON args | Notes |
| ---- | --------- | ----- |
| `list` | `{package, version?}` | All files: `{path, sizeBytes}` entries |
| `glob` | `{package, patterns, version?}` | `*`/`?`/`**` wildcards (case-insensitive); patterns without `/` match basenames at any depth (ripgrep-style), exact basename beats fuzzy; anchored full paths match exactly or by prefix; other bare text does fuzzy file-name matching |
| `read` | `{package, path, version?, offset?, limit?}` | Line-numbered content; caps: 2000 lines / 2000 chars per line / 50 KB per call |
| `grep` | `{package, pattern, version?, include?, wholeWord?, maxFiles?, fileOffset?}` | JS regex over file contents; `include` takes one glob or several (comma-separated); downloads at most 30 files per call starting at `fileOffset`; at most 50 result lines |

Version resolution:

1. Explicit `version` arg or inline `pkg@version` - exact, dist-tag, or semver range
2. Otherwise `latest`

## Workflow

1. Before importing an unfamiliar API: glob `"*.d.ts"`, then read the
   matching declaration file. Verify real exports and signatures instead of
   trusting memory.
2. File layout unknown? `list` or `glob` first, then `read` / `grep`.
3. grep searches file contents; to find a file or export by name use
   glob - bare queries fuzzy-match file names (e.g. an icon in lucide),
   while exact file names like "index.d.ts" match precisely.
4. Notable output fields: `read` returns `content` with line numbers and
   `truncated` - continue with `{"offset": N}`. `grep` may set `hint` - read
   it and follow it: `include` matched nothing (glob first), or files were
   skipped (continue with the suggested `fileOffset`, or narrow `include`).

## Large package strategy

- grep downloads at most 30 files per call. On icon/doc-heavy packages
  always pass `include` (e.g. `"dist/**/*.d.ts"`); for exhaustive sweeps
  page with `fileOffset` (the hint names the next value) or split `include`
  into several comma-separated patterns (`"arrow-left-*, arrow-big-*"`).
- read caps at 2000 lines / 50 KB per call; page through with `offset`.
- list/glob entries carry `sizeBytes` - use it to pick files worth reading
  (tiny files are often stubs/re-exports) without downloading.
- list on huge packages returns thousands of entries - prefer glob.

## Safety

Read-only HTTP against public CDNs. Zero dependencies, no eval, no shell,
no package code execution. The only disk writes are a local cache under
`~/.cache/libpeek` (fetched file contents, never executed; disable with
`LIBPEEK_NO_CACHE=1`) - the workspace under review is never written to.
To prefer the npmmirror CDN (China): `NPM_MIRROR=cn node scripts/index.mjs ...`.
Threat model: references/security.md. Full argument reference and error
codes: references/usage.md.
