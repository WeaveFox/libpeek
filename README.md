# libpeek

[![CI](https://img.shields.io/github/actions/workflow/status/WeaveFox/libpeek/ci.yml?branch=main)](https://github.com/WeaveFox/libpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#prerequisites)
[![Skills.sh](https://img.shields.io/badge/skills.sh-compatible-blue)](https://www.skills.sh)

**Browse any npm package like a local node_modules - real source code, no install, no sandbox, no code execution.**

libpeek reads the actual files of an exact npm package version straight from public CDNs: list the file tree, glob paths (wildcards or fuzzy), read any file, and grep contents - including `.d.ts` type definitions.

Built for AI coding agents in the vibe-coding loop: verify what a library really exports before you import it, instead of trusting training-data memory.

[中文文档](./README.zh-CN.md)

## Why

- **No sandbox needed** - no lifecycle scripts run, and the workspace under review is never written to. npm install hooks are the #1 supply-chain attack surface; libpeek has none.
- **Exact versions** - ask for `react@19.1.0`, `latest`, or `^19.0.0`; compare any version, not just the one installed.
- **Ground truth over memory** - models hallucinate APIs. The tarball doesn't.
- **Complements doc tools** - context7 and friends serve generated/curated documentation; libpeek serves source-code facts from the exact installed version. Docs for the mental model, libpeek when docs lag behind a release, cover only part of the API, or the question is "what does the code actually do".

## Install

### As an agent skill (recommended)

```bash
npx skills add WeaveFox/libpeek --skill libpeek
```

Works in Claude Code, Cursor, Codex, and 70+ agents via [skills.sh](https://skills.sh). See [SKILL.md](./skills/libpeek/SKILL.md).

### Standalone script

Node.js >= 18, nothing else:

```bash
node skills/libpeek/scripts/index.mjs list react
```

## Usage

```bash
# List every file in a package
node skills/libpeek/scripts/index.mjs list react@19.1.0

# Find files by name - wildcards, fuzzy, or exact
node skills/libpeek/scripts/index.mjs glob zod "dist/**/*.d.ts"
node skills/libpeek/scripts/index.mjs glob lucide-react arrow-left

# Read any file's source
node skills/libpeek/scripts/index.mjs read react package.json

# Search file contents across the package (scope with include)
node skills/libpeek/scripts/index.mjs grep '{"package":"zod","pattern":"exports","include":"package.json"}'
```

Version: explicit `version` or inline `pkg@version` wins; otherwise
`latest`. Full reference:
[references/usage.md](./skills/libpeek/references/usage.md).

## Safety

Read-only HTTP against public CDNs (unpkg / jsDelivr; `NPM_MIRROR=cn`
prefers npmmirror). Zero dependencies, no eval, no shell, no package code
execution; the only disk writes are a local cache under `~/.cache/libpeek`
(never executed, `LIBPEEK_NO_CACHE=1` to disable) - the workspace under
review is never written to. Threat model and review guide:
[references/security.md](./skills/libpeek/references/security.md).

## Configuration

| Env | Default | Purpose |
| --- | ------- | ------- |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Packument registry override |
| `NPM_MIRROR` | `intl` | `cn` prefers npmmirror for file contents |
| `NPM_FILE_MIRRORS` | built-in chain | Comma-separated URL templates, tried in order |
| `NPM_TIMEOUT` | `10000` | HTTP timeout (ms) |

## Hosted MCP

A free hosted MCP endpoint (`mcp.libpeek.dev`) exposing the same four tools
is on the roadmap. The skill + script is the zero-setup channel today.

## Roadmap

- `mdnpeek` - same read-only approach for MDN Web Docs (search / docs / browser compat)
- PyPI / crates.io adapters behind the same four commands
- Hosted free MCP endpoint

## License

[MIT](./LICENSE)
