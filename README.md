# libpeek

[![CI](https://img.shields.io/github/actions/workflow/status/WeaveFox/libpeek/ci.yml?branch=main)](https://github.com/WeaveFox/libpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#prerequisites)

**Peek into any npm package's source - without installing it.**

libpeek reads the actual files of an exact npm package version straight from public CDNs: list the file tree, glob paths (wildcards or fuzzy), read files with line numbers, and grep contents including `.d.ts` type definitions.

No `npm install`. No sandbox. No execution of third-party code. One auditable script, zero dependencies, read-only HTTP.

Built for AI coding agents in the vibe-coding loop: verify what a library really exports before you import it, instead of trusting training-data memory.

[中文文档](./README.zh-CN.md)

## Why

- **No sandbox needed** - nothing is written to disk, no lifecycle scripts run. npm install hooks are the #1 supply-chain attack surface; libpeek has none.
- **Exact versions** - ask for `react@19.1.0`, `latest`, or `^19.0.0`; or let libpeek pick the version your project's `package.json` actually declares, so what you read is what you run.
- **Ground truth over memory** - models hallucinate APIs. The tarball doesn't.

## Install

### As an agent skill (recommended)

```bash
npx skills add WeaveFox/libpeek --skill libpeek
```

Works in Claude Code, Cursor, Codex, and 70+ agents via [skills.sh](https://skills.sh). See [SKILL.md](./skills/libpeek/SKILL.md).

### Standalone script

The whole tool is one file. Node.js >= 18, nothing else:

```bash
node skills/libpeek/scripts/libpeek.mjs list react
```

## Usage

```bash
# List all files in a package (any version spec: exact, dist-tag, or range)
node skills/libpeek/scripts/libpeek.mjs list react@19.1.0

# Find files: wildcards or fuzzy bare queries
node skills/libpeek/scripts/libpeek.mjs glob zod "dist/**/*.d.ts"
node skills/libpeek/scripts/libpeek.mjs glob lucide-react arrow-left

# Read with line numbers (2000 lines / 50 KB per call; continue with --offset)
node skills/libpeek/scripts/libpeek.mjs read react package.json

# Regex-search contents (max 30 files per call; scope with --include)
node skills/libpeek/scripts/libpeek.mjs grep zod '"exports"' --include package.json
```

**Version alignment**: without `--version`, libpeek resolves the version
declared in your project's `package.json`, so `read`/`grep` results always
match what is actually installed. Explicit `pkg@version` or `--version`
always wins. Full reference: [references/usage.md](./skills/libpeek/references/usage.md).

## Safety

Read-only HTTP against public CDNs (unpkg / jsDelivr; `--mirror cn` prefers
npmmirror). Zero dependencies, no eval, no shell, no package code execution.
Threat model and review guide: [references/security.md](./skills/libpeek/references/security.md).

## Configuration

| Env | Default | Purpose |
| --- | ------- | ------- |
| `LIBPEAK_REGISTRY` | `https://registry.npmjs.org` | Packument registry override |
| `LIBPEAK_MIRROR` | `intl` | `cn` prefers npmmirror for file contents |
| `LIBPEAK_FILE_MIRRORS` | built-in chain | Comma-separated URL templates, tried in order |
| `LIBPEAK_TIMEOUT` | `10000` | HTTP timeout (ms) |

## Hosted MCP

A free hosted MCP endpoint (`mcp.libpeek.dev`) exposing the same four tools
is on the roadmap. The skill + script is the zero-setup channel today.

## Roadmap

- `mdnpeek` - same read-only approach for MDN Web Docs (search / docs / browser compat)
- PyPI / crates.io adapters behind the same four commands
- Hosted free MCP endpoint

## License

[MIT](./LICENSE)
