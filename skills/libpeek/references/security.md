# libpeek security model

## What libpeek does

libpeek is a single Node script with **zero runtime dependencies** that
performs read-only HTTP GET requests against the npm ecosystem:

| Data | Source (default) | Purpose |
| ---- | ---------------- | ------- |
| Packument (version metadata) | `registry.npmjs.org` | resolve dist-tags / semver ranges |
| File tree | `data.jsdelivr.com` (Data API) | `list` / `glob` |
| File contents | `unpkg.com`, then `cdn.jsdelivr.net` | `read` / `grep` |

With `--mirror cn` (or `LIBPEAK_MIRROR=cn`) file contents prefer
`registry.npmmirror.com` and fall through to unpkg / jsDelivr.
`LIBPEAK_FILE_MIRRORS` and `--registry` can point elsewhere; that is an
explicit operator decision, not a default.

## What libpeek never does

- Never **installs** anything - no `npm install`, no node_modules writes.
- Never **executes** fetched content - no eval, no Function constructor, no
  dynamic import, no spawn, no shell.
- Never **writes** to disk (beyond Node's own module cache reads).
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
3. **The script itself is the attack surface** - and it is one readable
   file, ~850 lines of plain JavaScript, no minification, no postinstall,
   no network beyond the table above. Review it once; pin it via git tags
   if you install the skill with `gh skill`.

## Recommended review before first use

```bash
# the whole runtime, in one screen-ful scroll
less scripts/libpeek.mjs
# confirm only these hosts are contacted
grep -n 'https://' scripts/libpeek.mjs
```
