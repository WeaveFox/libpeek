# libpeek usage reference

## Commands

| Command | Arguments | Notes |
| ------- | --------- | ----- |
| `list <pkg>` | - | All file paths in the package (leading `/`), sorted |
| `glob <pkg> <patterns...>` | one or more patterns (also comma-separated) | `*`/`?`/`**` wildcards (case-insensitive); bare text does fuzzy file-name matching |
| `read <pkg> <path>` | `--offset <n>`, `--limit <n>` | Line-numbered content; caps: 2000 lines / 2000 chars per line / 50 KB per call |
| `grep <pkg> <pattern>` | `--include <glob>`, `--whole-word`, `--max-files <n>` | JS regex over file contents; downloads at most 30 files per call; at most 50 result lines |

`<pkg>` accepts `name`, `name@version`, `@scope/name`, `@scope/name@version`.

## Options

| Option | Values | Meaning |
| ------ | ------ | ------- |
| `--version <spec>` | exact / dist-tag / semver range | Overrides inline `pkg@spec` and manifest alignment |
| `--include <glob>` | e.g. `dist/**/*.d.ts` | grep: scope searched files (glob semantics, relative patterns allowed) |
| `--whole-word` | flag | grep: wrap pattern in `\b...\b` |
| `--max-files <n>` | default 30 | grep: download cap per call |
| `--offset <n>` | 1-indexed | read: start line |
| `--limit <n>` | default 2000 | read: max lines |
| `--mirror <mode>` | `intl` (default) / `cn` | File-content mirror chain |
| `--registry <url>` | default `https://registry.npmjs.org` | Packument registry override (any npm-registry-compatible API) |
| `--project <dir>` | default cwd | Directory whose package.json provides declared versions |
| `--no-project` | flag | Disable manifest alignment |
| `--timeout <ms>` | default 10000 | HTTP timeout |
| `--pretty` | flag | Pretty-print JSON |

Environment equivalents: `LIBPEAK_REGISTRY`, `LIBPEAK_MIRROR`,
`LIBPEAK_FILE_MIRRORS` (comma-separated URL templates with `{name}`,
`{version}`, `{path}` placeholders - tried in order),
`LIBPEAK_TIMEOUT`.

## Version resolution priority

```
--version flag  >  inline "pkg@spec"  >  project manifest (deps/devDeps/peerDeps/optionalDeps)  >  latest
```

Exact versions skip the registry entirely. `latest` / dist-tags / ranges
resolve via the packument endpoint. Semver support is a pragmatic subset:
`^ ~ > >= < <= =`, x-ranges (`1`, `1.2`, `1.x`, `*`), `||` alternatives, and
hyphen ranges (`1.2.3 - 2`). Known subset edges: `<=M.m` treats the bound as
`<(M.(m+1).0)` (the `2.0.0-0` boundary edge is accepted), and prerelease
versions only match ranges that mention a prerelease.

## Output schemas

Every command prints one JSON object and exits 0; errors print
`{"error":true,"code":...,"message":...}` and exit 1.

- `list` -> `{package, version, spec, count, files[]}`
- `glob` -> `{package, version, spec, patterns[], count, matches[]}`
- `read` -> `{package, version, spec, path, startLine, endLine, totalLines, sizeBytes, truncated, content}`
- `grep` -> `{package, version, spec, count, truncated, filesSearched, filesSkipped, matches[{file,line,text}], hint?}`

`hint` is advisory text for the agent: it appears when `--include` matched no
files (use `glob` first, or drop `--include`) or when files were skipped due
to the download cap (narrow with `--include`).

## Error codes

| Code | Meaning | Recovery |
| ---- | ------- | -------- |
| `usage` | Bad CLI invocation | Follow the message / `--help` |
| `bad_name` | Package name failed validation | Check spelling of `name` / `@scope/name` |
| `bad_path` | Invalid path, or `--offset` beyond EOF | Fix path; for EOF use a smaller `--offset` |
| `no_version` | No dist-tag and no version satisfies the range | List real versions via the registry; loosen the range |
| `invalid_range` | Unparseable semver spec | Quote ranges in the shell (`' ^3 '`); check `||` tokens |
| `invalid_regex` | Bad grep regex | Escape special characters |
| `binary_file` | read on a binary extension | Read the sibling `.d.ts`/`.js` instead |
| `not_found` | File absent from that version's tarball | `list`/`glob` to find real paths; note TS7-style packages restructure |
| `http` | Network/CDN failure after all mirrors | Retry; or switch `--mirror cn` / `--registry` |

## Truncation semantics (read)

- Lines longer than 2000 chars are cut with `... (line truncated to 2000 chars)`.
- Output caps at 50 KB: trailer `(Output capped at 50 KB. Showing lines x-y. Use --offset z to continue.)`
- Otherwise line-capped: `(Showing lines x-y of total. Use --offset z to continue.)`
- Full read: `(End of file - total N lines)`

## Examples

```bash
# Ground-truth check before importing: find and read the d.ts
node scripts/libpeek.mjs glob zod "dist/**/*.d.ts"
node scripts/libpeek.mjs read zod@3.25.76 dist/index.d.ts --limit 120

# How does the installed version implement X?
node scripts/libpeek.mjs grep wouter "function useLocation" --include "*.d.ts"

# Fuzzy-find an icon file by name
node scripts/libpeek.mjs glob lucide-react arrow-left-circle

# Manifest alignment (no version flags - uses your package.json)
cd your-project && node scripts/libpeek.mjs list react

# China acceleration
node scripts/libpeek.mjs read react package.json --mirror cn

# Private/compatible registry (read-only packument queries)
node scripts/libpeek.mjs list @scope/pkg --registry https://nexus.corp.example/repository/npm-group/
```
