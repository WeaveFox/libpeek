# libpeek usage reference

## Calling

From the skill's directory:

```bash
# Positional form - quick calls
node scripts/index.mjs list react
node scripts/index.mjs read react package.json
node scripts/index.mjs glob lucide-react arrow-left

# JSON form - full arguments (same shape as MCP tool calls)
node scripts/index.mjs grep '{"package":"zod","pattern":"exports","include":"package.json"}'
```

Every call prints one JSON object and exits 0; failures print
`{"error":true,"code":...,"message":...}` and exit 1.

## Tools

| Tool | Arguments (JSON form) | Notes |
| ---- | --------------------- | ----- |
| `list` | `{package, version?}` | All files in the package: `{path, sizeBytes}` entries (leading `/`), sorted |
| `glob` | `{package, patterns, version?}` | `patterns` is an array or comma-separated string; `*`/`?`/`**` wildcards (case-insensitive); patterns without `/` match basenames at any depth (ripgrep-style), exact basename beats fuzzy; anchored full paths (`/dir/file.js`, `/dir/`) match exactly or by prefix; other bare text does fuzzy file-name matching; matches carry `{path, sizeBytes}` |
| `read` | `{package, path, version?, offset?, limit?}` | Line-numbered content; caps: 2000 lines / 2000 chars per line / 50 KB per call |
| `grep` | `{package, pattern, version?, include?, wholeWord?, maxFiles?, fileOffset?}` | JS regex over file contents; `include` takes one glob or several (array / comma-separated); downloads at most 30 files per call starting at `fileOffset` (1-indexed); at most 50 result lines |

`package` accepts `name`, `name@version`, `@scope/name`, `@scope/name@version`.

## Version resolution priority

```
explicit version arg  >  inline "pkg@spec"  >  latest
```

Exact versions skip the registry entirely. `latest` / dist-tags / ranges
resolve via the packument endpoint. Semver support is a pragmatic subset:
`^ ~ > >= < <= =`, x-ranges (`1`, `1.2`, `1.x`, `*`), `||` alternatives,
hyphen ranges (`1.2.3 - 2`), and prerelease comparators (`>=1.3.0-beta.1`).
Known subset edges: `<=M.m` treats the bound as `<(M.(m+1).0)` (the
`2.0.0-0` boundary edge is accepted), and prerelease versions only match
ranges that mention a prerelease.

## Output schemas

- `list` -> `{package, version, spec, count, files[{path, sizeBytes}]}`
- `glob` -> `{package, version, spec, patterns[], count, matches[{path, sizeBytes}]}`
- `read` -> `{package, version, spec, path, startLine, endLine, totalLines, sizeBytes, truncated, content}`
- `grep` -> `{package, version, spec, count, truncated, filesSearched, filesSkipped, matches[{file,line,text}], hint?}`

`sizeBytes` comes from the source tree - use it to judge which files are
worth reading without downloading (tiny files are often stubs/re-exports).

`hint` is advisory text for the agent: it appears when `include` matched no
files (use glob first, or drop include) or when files were skipped due to
the download cap (continue with the suggested `fileOffset`, or narrow with
`include`). `truncated` means the result is incomplete: hit lines were
capped at 50, or `filesSkipped > 0`.

## Error codes

Every listed code is actionable - follow the Recovery column instead of
stopping. Only `internal` means a real bug: show it to the user and stop.

| Code | Meaning | Recovery |
| ---- | ------- | -------- |
| `usage` | Missing/invalid tool arguments | Follow the message; check the args table above |
| `bad_name` | Package name failed validation | Check spelling of `name` / `@scope/name` |
| `bad_path` | Invalid path, or `offset` beyond EOF | Fix path; for EOF use a smaller `offset` |
| `no_version` | No dist-tag and no version satisfies the range | Loosen the range |
| `invalid_range` | Unparseable semver spec | Quote ranges in the shell (`'^3'`); check `||` tokens |
| `invalid_regex` | Bad grep regex | Escape special characters |
| `binary_file` | read on a binary extension | Read the sibling `.d.ts`/`.js` instead |
| `not_found` | File absent from that version's tarball | `list`/`glob` to find real paths; note TS7-style packages restructure |
| `http` | Network/CDN failure after all mirrors | Retry; or switch mirrors via `NPM_MIRROR=cn` / `NPM_REGISTRY` |

## Matching semantics (glob patterns & grep include)

- `*`/`?`/`**` wildcards (case-insensitive); patterns without `/` match
  basenames at any depth (ripgrep-style); anchored full paths
  (`/dir/file.js`) match exactly or by prefix (`/dir/` pulls the folder).
- Bare text first tries an exact basename hit ("faCircleDown.js" stays
  precise), then falls back to fuzzy file-name matching ("arrow-left"). In
  grep `include`, exact-first keeps a specific file from expanding into
  fuzzy lookalikes that would eat the `maxFiles` cap.

## Truncation semantics (read)

- Lines longer than 2000 chars are cut with `... (line truncated to 2000 chars)`.
- Output caps at 50 KB: trailer `(Output capped at 50 KB. Showing lines x-y. Continue with offset z.)`
- Otherwise line-capped: `(Showing lines x-y of total. Continue with offset z.)`
- Full read: `(End of file - total N lines)`

## Truncation semantics (grep)

- At most 50 result lines and `maxFiles` (default 30) files per call.
- `truncated: true` = the result is incomplete: hit lines were capped, or
  `filesSkipped > 0` (files beyond the cap; candidate order is stable).
- Exhaustive sweeps: page with `fileOffset` (the hint names the next value)
  and/or split `include` into several patterns
  (`"a-*.js, b-*.js"` or `["a-*.js","b-*.js"]`).

## Environment

| Env | Default | Purpose |
| --- | ------- | ------- |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Packument registry override (any npm-registry-compatible API) |
| `NPM_MIRROR` | `intl` | `cn` prefers npmmirror for file contents |
| `NPM_FILE_MIRRORS` | built-in chain | Comma-separated URL templates with `{name}`, `{version}`, `{path}` - tried in order |
| `NPM_TIMEOUT` | `10000` | HTTP timeout (ms) |

## Examples

```bash
# Ground-truth check before importing: find and read the d.ts
node scripts/index.mjs glob zod '{"patterns":["dist/**/*.d.ts"]}'
node scripts/index.mjs read '{"package":"zod@3.25.76","path":"dist/index.d.ts","limit":120}'

# How does the installed version implement X?
node scripts/index.mjs grep '{"package":"wouter","pattern":"function useLocation","include":"*.d.ts"}'

# Fuzzy-find an icon file by name
node scripts/index.mjs glob lucide-react arrow-left-circle

# Page an exhaustive sweep; the hint names the next fileOffset value
node scripts/index.mjs grep '{"package":"lucide-react","pattern":"export","include":"arrow-*","fileOffset":31}'

# Pin a version explicitly (defaults to latest)
node /path/to/skills/libpeek/scripts/index.mjs list '{"package":"react","version":"^19.0.0"}'

# China acceleration
NPM_MIRROR=cn node scripts/index.mjs read react package.json

# Private/compatible registry (read-only packument queries)
NPM_REGISTRY=https://nexus.corp.example/repository/npm-group/ node scripts/index.mjs list @scope/pkg
```
