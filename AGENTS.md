# Agents

## Overview

libpeek is a single-skill repository: one agent skill
(`skills/libpeek/SKILL.md` + bundled scripts) that reads npm package source
without installing it.

The runtime is three modules in `skills/libpeek/scripts/`, layered the way
data flows:

- `vfs.mjs` - the read-only virtual filesystem: standard `list` / `glob` /
  `read` / `grep` semantics over a virtual fs ({files, contents, load})
  supplied by a data source. Stateless; never touches the network (`load`
  is injected).
  Reusable by any future data source (pypi.mjs, crates.mjs, ...).
- `npm.mjs` - the npm data source: semver subset, packument resolution,
  jsDelivr file trees, mirror chains, and the per-target virtual fs cache
  (files + fetched contents, reused across calls), backed by an on-disk
  cache under `~/.cache/libpeek` (immutable `name@version` payloads,
  best-effort writes, mtime-based LRU eviction via `LIBPEEK_CACHE_MAX_MB`,
  default 256 MB; `LIBPEEK_NO_CACHE=1` to disable). The only module that
  talks to the network.
- `index.mjs` - tool entry: MCP-shaped `tools` functions (args contract +
  orchestration only) plus a thin direct-execution shim (positional or
  JSON args, no flag parsing).

Dependency direction is strictly one-way: `index -> npm -> files`.

Distribution: skills.sh (`npx skills add WeaveFox/libpeek --skill libpeek`).
No npm package is published; the GitHub repo itself is the registry.

## Directory Structure

```plain
libpeek/
├── skills/
│   └── libpeek/
│       ├── SKILL.md            # Skill definition: frontmatter + core workflow (progressive disclosure)
│       ├── scripts/
│       │   ├── vfs.mjs         # Read-only virtual FS: list/glob/read/grep over a virtual fs (no network)
│       │   ├── npm.mjs         # npm data source: semver, packument, mirrors, virtual fs cache (~/.cache/libpeek)
│       │   └── index.mjs       # Tool entry: args contract + orchestration + JSON shim
│       └── references/
│           ├── usage.md        # Full argument reference, output schemas, error codes (loaded on demand)
│           └── security.md     # Threat model + review guide (loaded on demand)
├── tests/
│   ├── vfs.test.mjs            # node:test for vfs.mjs: matching, read format, grep scan
│   ├── npm.test.mjs            # node:test for npm.mjs: semver + stubbed-fetch source tests
│   └── shim.test.mjs           # node:test for the index.mjs shim (spawnSync, offline)
├── README.md / README.zh-CN.md / AGENTS.md
├── LICENSE
├── package.json        # private; toolchain only (commitlint + husky), zero runtime deps
├── commitlint.config.mjs
├── .husky/commit-msg
└── .github/workflows/ci.yml
```

## Zero-dependency rules

- The three modules under `skills/libpeek/scripts/` are the only runtime
  code. Only `node:` builtins and relative imports between them - no
  third-party packages, ever; the auditability claim in
  references/security.md depends on it.
- No build step. `node --check` per module is the lint; `node --test` runs
  the offline unit tests in `tests/`.
- No CLI flag parsing: tools take ONE args object (MCP shape) and the shim
  accepts positional args or a single JSON object. Keep tool signatures
  stable - they are the product surface, and a future hosted MCP server
  maps onto them 1:1.

## Layering rules

- `vfs.mjs` must never import `npm.mjs` and never touch the network;
  `npm.mjs` must never import `index.mjs`. Dependencies flow one way:
  `index -> npm -> vfs`.
- Ecosystem-specific logic (mirrors, tree/contents fetching, virtual fs
  cache) lives in the data-source module; fs semantics (matching,
  truncation, grep scanning) live in vfs.mjs. When a second ecosystem
  lands, vfs.mjs must not change.

## Semantics parity

The modules intentionally mirror the semantics of the internal
`npm-explorer` they were extracted from (read: 2000 lines / 50 KB /
2000-char lines; grep: 30-file download cap, 50-result cap, binary skip,
include-hint; glob: wildcard + fuzzy fallback). Changing any of those
numbers or formats is a behavior change - update SKILL.md,
references/usage.md, and the parity note here in the same commit.

## SKILL.md rules

- Body stays under ~5k tokens; push detail into `references/` (progressive
  disclosure - only SKILL.md frontmatter is always loaded).
- Scripts are referenced relative to the skill's own directory
  (`node scripts/index.mjs ...`), never from the repo layout - agents
  resolve paths from where the skill is installed.
- `description` is the only activation signal. Changes to it must be
  validated by triggering the skill with real phrasing before merging.

## Commands

```bash
pnpm lint          # node --check every module
pnpm test          # node:test unit tests (offline)
pnpm smoke:list    # real-network smoke: list react
pnpm smoke         # real-network smoke: list/glob/read/grep
```

Local mirror check (China acceleration):

```bash
NPM_MIRROR=cn node skills/libpeek/scripts/index.mjs read wouter package.json
```

## Release

No npm publishing. Releases are git tags (`v0.x.y`) - useful for
`gh skill install WeaveFox/libpeek libpeek@<tag>` pinning. Tag only when CI
is green and the smoke commands pass locally.

## Verification checklist (after touching the scripts)

1. `pnpm lint`
2. `pnpm test`
3. `pnpm smoke` (real network)
4. `node skills/libpeek/scripts/index.mjs list 'zod@^3'` (semver path)
5. `NPM_MIRROR=cn node skills/libpeek/scripts/index.mjs read wouter package.json` (mirror fallthrough)
6. One large-package check: `node skills/libpeek/scripts/index.mjs read '{"package":"typescript@5.9.2","path":"lib/typescript.d.ts"}'` (50 KB cap)
