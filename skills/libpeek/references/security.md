# libpeek security model

## What libpeek does

libpeek is three plain Node modules with **zero runtime dependencies**
(`vfs.mjs` read-only filesystem primitives, `npm.mjs` npm data source,
`index.mjs` tool entry) that perform read-only HTTP GET requests against
the npm ecosystem:

| Data | Source (default) | Purpose |
| ---- | ---------------- | ------- |
| Packument (version metadata) | `registry.npmjs.org` | resolve dist-tags / semver ranges |
| File tree | `data.jsdelivr.com` (Data API) | `list` / `glob` |
| File contents | `unpkg.com`, then `cdn.jsdelivr.net` | `read` / `grep` |

With `NPM_MIRROR=cn` file contents prefer `registry.npmmirror.com` and
fall through to unpkg / jsDelivr. `NPM_FILE_MIRRORS` and `NPM_REGISTRY`
can point elsewhere; that is an explicit operator decision, not a default.

The only disk writes are a local cache under `~/.cache/libpeek` (fetched
file trees and contents, keyed per `name@version`, never executed; LRU
capped by `LIBPEEK_CACHE_MAX_MB`, default 256; disabled entirely with
`LIBPEEK_NO_CACHE=1`).

## What libpeek never does

- Never **installs** anything - no `npm install`, no node_modules writes.
- Never **executes** fetched content - no eval, no Function constructor, no
  dynamic import, no spawn, no shell.
- Never **touches the workspace under review** - the only disk writes are
  the local cache under `~/.cache/libpeek` (file trees and fetched
  contents, keyed per `name@version`, never executed; process-lifetime
  memory caches on top of it).
- No telemetry, no cookies, no credentials - there is nothing to leak.

npm supply-chain attacks overwhelmingly fire during **install lifecycle
scripts** (postinstall). libpeek does not trigger any of them: it reads the
same bytes npm would download, minus the execution surface.

## Trust boundaries

1. **Content integrity** equals "what npm published". libpeek serves the
   tarball contents via CDN mirrors, the same trust decision as downloading
   the tarball from the registry - but without lifecycle-script execution.
   We do not verify per-file integrity hashes: registry integrity is
   committed against the whole tarball, and CDN file endpoints have no
   equivalent single-file proof. Treat libpeek output as advisory ground
   truth for reading, and always install with checksum verification before
   *running* anything.
2. **Mirror chain is a fixed protocol allowlist.** Default URLs are hardcoded
   to public CDNs; package names are validated (`@scope/name` charset) before
   any URL is built, so a package name cannot smuggle a URL.
3. **The local cache is trusted by position, not verified.** Cached trees
   and contents under `~/.cache/libpeek` are served back without integrity
   checks. The assumption matches npm's `_cacache` and pnpm's store: anyone
   able to write your home cache dir already controls your environment,
   which is outside this threat model. Cache poisoning cannot execute
   anything and cannot reach the workspace. `LIBPEEK_NO_CACHE=1` removes
   the surface entirely.
4. **The scripts are the attack surface** - and they are three readable
   modules (~1160 lines total) of plain JavaScript, no minification, no
   postinstall, no network beyond the table above (only `npm.mjs` fetches).
   Review them once; pin via git tags if you install the skill with
   `gh skill`.

## Recommended review before first use

```bash
# the whole runtime: three files, sizes first
wc -l scripts/*.mjs
# confirm only these hosts are contacted (all URLs live in npm.mjs)
grep -n 'https://' scripts/*.mjs
```
