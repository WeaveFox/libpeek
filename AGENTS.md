# Agents

## Overview

libpeek is a single-skill repository: one agent skill
(`skills/libpeek/SKILL.md` + bundled
script) that reads npm package source without installing it. The entire
runtime is `skills/libpeek/scripts/libpeek.mjs` - one auditable file, zero runtime
dependencies, read-only HTTP only.

Distribution: skills.sh (`npx skills add WeaveFox/libpeek --skill libpeek`).
No npm package
is published; the GitHub repo itself is the registry.

## Directory Structure

```plain
libpeek/
├── skills/
│   └── libpeek/
│       ├── SKILL.md            # Skill definition: frontmatter (name + description) + core instructions
│       ├── scripts/
│       │   └── libpeek.mjs     # Whole runtime: list/glob/read/grep, inline semver + glob/fuzzy
│       └── references/
│           ├── usage.md        # Full option reference, output schemas, error codes (loaded on demand)
│           └── security.md     # Threat model + review guide (loaded on demand)
├── README.md / README.zh-CN.md
├── AGENTS.md
├── LICENSE
├── package.json        # private; toolchain only (commitlint + husky), zero runtime deps
├── commitlint.config.mjs
├── .husky/commit-msg
└── .github/workflows/ci.yml
```

## Zero-dependency rules

- `skills/libpeek/scripts/libpeek.mjs` is the only runtime code. Only `node:` builtins may
  be imported; no third-party packages, ever - the auditability claim in
  references/security.md depends on it.
- No build step. `node --check skills/libpeek/scripts/libpeek.mjs` is the lint.
- Keep output contracts stable: commands always emit one JSON object, errors
  are `{"error":true,"code":...}` with exit 1.

## Semantics parity

The script intentionally mirrors the semantics of the internal
`npm-explorer` it was extracted from (read: 2000 lines / 50 KB / 2000-char
lines; grep: 30-file download cap, 50-result cap, binary skip, include-hint;
glob: wildcard + fuzzy fallback). Changing any of those numbers or formats
is a behavior change - update SKILL.md, references/usage.md, and the parity
note here in the same commit.

## SKILL.md rules

- Body stays under ~5k tokens; push detail into `references/` (progressive
  disclosure - only SKILL.md frontmatter is always loaded).
- Scripts are referenced relative to the skill's own directory
  (`node skills/libpeek/scripts/libpeek.mjs ...`), never from the repo layout - agents
  resolve paths from where the skill is installed.
- `description` is the only activation signal. Changes to it must be
  validated by triggering the skill with real phrasing before merging.

## Commands

```bash
pnpm lint          # node --check skills/libpeek/scripts/libpeek.mjs
pnpm smoke:list    # real-network smoke: list react
pnpm smoke         # real-network smoke: list/glob/read/grep
```

Local mirror check (China acceleration):

```bash
node skills/libpeek/scripts/libpeek.mjs read wouter package.json --mirror cn
```

## Release

No npm publishing. Releases are git tags (`v0.x.y`) - useful for
`gh skill install WeaveFox/libpeek <skill>@<tag>` pinning. Tag only when CI
is green and the four smoke commands pass locally.

## Verification checklist (after touching the script)

1. `pnpm lint`
2. `pnpm smoke` (real network)
3. `node skills/libpeek/scripts/libpeek.mjs list 'zod@^3'` (semver path)
4. `node skills/libpeek/scripts/libpeek.mjs read wouter package.json --mirror cn` (mirror fallthrough)
5. One large-package check: `node skills/libpeek/scripts/libpeek.mjs read typescript@5.9.2 lib/typescript.d.ts` (50 KB cap)
