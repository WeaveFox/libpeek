/**
 * npm data source: version resolution, file trees, file contents, semver
 * subset, plus a per-target virtual-fs cache (files + fetched contents),
 * backed by an on-disk cache under the XDG cache dir (~/.cache/libpeek).
 * Config via NPM_* env vars (see CONFIG).
 */

import { error } from './vfs.mjs';
import { readFile, writeFile, mkdir, rename, rm, stat, utimes, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Packument endpoints (version resolution). Configurable for private/mirror registries. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** File-content mirror chains, tried in order ({name} {version} {path}). */
const MIRRORS_INTL = [
  'https://unpkg.com/{name}@{version}/{path}',
  'https://cdn.jsdelivr.net/npm/{name}@{version}/{path}',
];
const MIRRORS_CN = [
  'https://registry.npmmirror.com/{name}/{version}/files/{path}',
  'https://unpkg.com/{name}@{version}/{path}',
  'https://cdn.jsdelivr.net/npm/{name}@{version}/{path}',
];

/** File-tree provider (list/glob base). jsDelivr Data API returns a nested tree. */
const JSDELIVR_DATA_API = 'https://data.jsdelivr.com/v1/packages/npm/{name}@{version}';

function readEnvMirrors() {
  const custom = process.env.NPM_FILE_MIRRORS;
  if (custom) {
    const list = custom.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  return process.env.NPM_MIRROR === 'cn' ? MIRRORS_CN : MIRRORS_INTL;
}

/** Resolved once from env; `ua` is injected by the tool entry. */
export const CONFIG = {
  ua: 'vfs-client',
  registry: (process.env.NPM_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, ''),
  mirrors: readEnvMirrors(),
  timeoutMs: Number(process.env.NPM_TIMEOUT) || 10000,
};

// ─── In-process HTTP (dedupe cache; failures are never cached) ───────────────

const inflight = new Map();

async function fetchText(url) {
  if (inflight.has(url)) return inflight.get(url);
  const promise = (async () => {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(CONFIG.timeoutMs),
        headers: {
          'user-agent': CONFIG.ua,
          // Abbreviated packument: same dist-tags + version keys, far smaller
          // for large packages. Plain JSON endpoints ignore it.
          accept: 'application/vnd.npm.install-v1+json, application/json',
        },
      });
      // res.text() stays inside the try: body reads share the abort signal,
      // so slow bodies must surface as expected http errors, not internal.
      const text = await res.text();
      if (!res.ok) {
        const err = error('http', `HTTP ${res.status} ${res.statusText} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return text;
    } catch (err) {
      if (err?.expected) throw err; // already wrapped - keep code and status
      throw error('http', `Network error for ${url}: ${err?.cause?.message ?? err.message}`);
    }
  })();
  inflight.set(url, promise);
  promise.catch(() => inflight.delete(url));
  return promise;
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch {
    throw error('http', `Invalid JSON response from ${url}`);
  }
}

// ─── Minimal semver (pragmatic subset) ───────────────────────────────────────

/** Exact semver (no resolution needed against the registry). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(raw).trim());
  if (!m) return null;
  return {
    raw: String(raw).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Semver precedence: numeric fields, then prerelease (release > prerelease). */
export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** "1.2.x" / "1" / "*" tokens (+prerelease suffix, full versions only); null = wildcard. */
export function parseXRange(token) {
  if (token === '*' || token === 'x' || token === 'X') {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  // Detach a prerelease suffix first: "1.3.0-beta.1" -> core "1.3.0" + pre "beta.1"
  let prerelease = [];
  let requireFull = false;
  const dash = token.indexOf('-');
  if (dash !== -1) {
    const pre = token.slice(dash + 1);
    if (pre === '' || !pre.split('.').every((s) => /^[0-9A-Za-z-]+$/.test(s))) return null;
    prerelease = pre.split('.');
    token = token.slice(0, dash);
    requireFull = true;
  }
  const parts = token.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const out = { major: null, minor: null, patch: null, prerelease };
  const keys = ['major', 'minor', 'patch'];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'x' || p === 'X' || p === '*') break; // wildcards imply the rest is wildcard
    if (!/^\d+$/.test(p)) return null;
    out[keys[i]] = Number(p);
  }
  if (requireFull && (out.minor === null || out.patch === null)) return null;
  return out;
}

/** One comparator group (no "||"), hyphen ranges included; [] = any. */
function parseComparatorGroup(str) {
  const tokens = str.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens.length === 1 && ['*', 'x', 'X', ''].includes(tokens[0]))) return [];

  // Hyphen range: <lo> - <hi>
  const hyphenIdx = tokens.indexOf('-');
  if (hyphenIdx !== -1) {
    if (hyphenIdx !== 1 || tokens.length !== 3) {
      throw error('invalid_range', `Invalid hyphen range: "${str}"`);
    }
    return [...desugarLoose(tokens[0], '>='), ...desugarLoose(tokens[2], '<=')];
  }

  const comparators = [];
  for (const token of tokens) {
    let rest = token;
    let op = '';
    const m = /^(>=|<=|>|<|=|\^|~)/.exec(rest);
    if (m) {
      op = m[1];
      rest = rest.slice(op.length);
    }
    if (!/^[\dxX*.]/.test(rest)) {
      throw error('invalid_range', `Invalid version range token: "${token}"`);
    }
    const parts = parseXRange(rest); // {major, minor, patch, prerelease}, null = wildcard
    if (parts === null) {
      throw error('invalid_range', `Invalid version range token: "${token}"`);
    }
    comparators.push(...desugar(op, parts));
  }
  return comparators;
}

/** Missing levels fill with 0 below; the exclusive bound bumps the first missing level. */
function desugar(op, { major: M, minor: m, patch: p, prerelease: pre = [] }) {
  if (M === null) return []; // "*" -> any

  if (op === '^') {
    const lower = { major: M, minor: m ?? 0, patch: p ?? 0, prerelease: pre };
    let upper;
    if (m === null) upper = { major: M + 1, minor: 0, patch: 0 };
    else if (p === null) upper = M === 0 ? { major: 0, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0 };
    else if (M > 0) upper = { major: M + 1, minor: 0, patch: 0 };
    else if (m > 0) upper = { major: 0, minor: m + 1, patch: 0 };
    else upper = { major: 0, minor: 0, patch: p + 1 };
    return [cmp('>=', lower), cmp('<', upper)];
  }
  if (op === '~') {
    const lower = { major: M, minor: m ?? 0, patch: p ?? 0, prerelease: pre };
    const upper = m === null ? { major: M + 1, minor: 0, patch: 0 } : { major: M, minor: m + 1, patch: 0 };
    return [cmp('>=', lower), cmp('<', upper)];
  }
  if (op === '>' || op === '<' || op === '<=' || op === '>=') {
    const hasMinor = m !== null;
    const hasPatch = p !== null;
    switch (op) {
      case '>':
        // >1.2 := >=1.3.0 ; >1 := >=2.0.0 ; full version stays as-is
        return [
          cmp('>=', hasMinor ? { major: M, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0, prerelease: [] }),
        ];
      case '<':
        // <1.2 := <1.2.0
        return [cmp('<', { major: M, minor: m ?? 0, patch: p ?? 0, prerelease: pre })];
      case '>=':
        return [cmp('>=', { major: M, minor: m ?? 0, patch: p ?? 0, prerelease: pre })];
      case '<=':
        // <=1.2 := <1.3.0 (2.0.0-0 boundary edge accepted)
        return [
          cmp('<', hasMinor ? { major: M, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0, prerelease: [] }),
        ];
      default:
        break;
    }
  }
  // No operator: full version -> exact; partial -> half-open x-range
  if (m !== null && p !== null) return [cmp('=', { major: M, minor: m, patch: p, prerelease: pre })];
  if (m !== null) return [cmp('>=', { major: M, minor: m, patch: 0 }), cmp('<', { major: M, minor: m + 1, patch: 0 })];
  return [cmp('>=', { major: M, minor: 0, patch: 0 }), cmp('<', { major: M + 1, minor: 0, patch: 0 })];
}

/** Hyphen-range endpoint: bare partial version as >=lo / <=hi(with upper bound). */
function desugarLoose(token, sideOp) {
  const parts = parseXRange(token);
  if (parts === null || parts.major === null) {
    throw error('invalid_range', `Invalid hyphen range endpoint: "${token}"`);
  }
  const { major: M, minor: m, patch: p, prerelease: pre } = parts;
  if (sideOp === '>=') return [cmp('>=', { major: M, minor: m ?? 0, patch: p ?? 0, prerelease: pre })];
  // Upper: "2" -> <3.0.0, "2.3" -> <2.4.0, "2.3.4" -> <=2.3.4
  if (m === null) return [cmp('<', { major: M + 1, minor: 0, patch: 0 })];
  if (p === null) return [cmp('<', { major: M, minor: m + 1, patch: 0 })];
  return [cmp('<=', { major: M, minor: m, patch: p, prerelease: pre })];
}

function cmp(op, ver) {
  return { op, ver: { major: ver.major, minor: ver.minor, patch: ver.patch, prerelease: ver.prerelease ?? [] } };
}

function testComparator(version, comparator) {
  if (comparator === null) return true;
  const c = compareVersions(version, comparator.ver);
  switch (comparator.op) {
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '=':
      return c === 0;
    default:
      return false;
  }
}

/** A prerelease version only satisfies ranges that mention a prerelease. */
function satisfies(version, groups) {
  if (version.prerelease.length > 0) {
    const mentionsPrerelease = groups.some((g) => g.some((c) => c && c.ver.prerelease.length > 0));
    if (!mentionsPrerelease) return false;
  }
  return groups.some((group) => group.every((c) => testComparator(version, c)));
}

export function maxSatisfying(versionList, spec) {
  const groups = spec
    .split('||')
    .map((g) => parseComparatorGroup(g.trim()))
    .filter((g) => g !== null);
  if (groups.length === 0) throw error('invalid_range', `Invalid version range: "${spec}"`);

  let best = null;
  for (const raw of versionList) {
    const v = parseVersion(raw);
    if (!v || !satisfies(v, groups)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best ? best.raw : null;
}

// ─── Package names, version resolution, file access ──────────────────────────

/** npm package name: optional @scope/name. Guards every URL we build. */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

export function assertPackageName(name) {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw error('bad_name', `Invalid npm package name: "${name}"`);
  }
}

/** "react", "react@19.1.0", "@scope/pkg@^1" -> {name, spec}; spec loses to an explicit version. */
export function splitPackageArg(arg) {
  const atIndex = arg.startsWith('@') ? arg.indexOf('@', 1) : arg.indexOf('@');
  if (atIndex === -1) return { name: arg, spec: undefined };
  return { name: arg.slice(0, atIndex), spec: arg.slice(atIndex + 1) || undefined };
}

/**
 * Resolve latest / dist-tag / semver range to an exact version.
 * Exact versions skip the registry entirely.
 */
export async function resolveVersion(name, spec) {
  if (EXACT_VERSION_RE.test(spec)) return spec;

  const packument = await fetchJson(`${CONFIG.registry}/${name}`);
  const distTags = packument?.['dist-tags'];
  if (distTags && typeof distTags === 'object' && distTags[spec] !== undefined) {
    return distTags[spec];
  }
  if (spec === 'latest') {
    throw error('no_version', `Package ${name} has no "latest" dist-tag`);
  }
  const versions = Object.keys(packument?.versions ?? {});
  if (versions.length === 0) {
    throw error('no_version', `No published versions found for ${name}`);
  }
  const best = maxSatisfying(versions, spec);
  if (best) return best;
  throw error('no_version', `No version of ${name} matches "${spec}" (available: ${versions.length})`);
}

/** jsDelivr Data API: nested tree whose `name`s are relative to their parent. */
function flattenFileTree(entries, parentPath = '') {
  const files = [];
  for (const entry of entries ?? []) {
    const path = `${parentPath}/${entry.name}`;
    if (entry.type === 'directory') {
      files.push(...flattenFileTree(entry.files, path));
    } else {
      files.push({ path, sizeBytes: entry.size });
    }
  }
  return files;
}

async function listFiles(name, version) {
  const dir = cacheDirFor(name, version);
  const cached = await readTreeCache(dir);
  if (cached) return cached;
  const url = JSDELIVR_DATA_API.replaceAll('{name}', name).replaceAll('{version}', version);
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.files)) {
    throw error('http', `Unexpected file-tree response for ${name}@${version}`);
  }
  const files = flattenFileTree(data.files).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await writeTreeCache(dir, files);
  return files;
}

/** Try the mirror chain in order; all-404 => the file is not in the tarball. */
async function fetchPackageFile(name, version, filePath) {
  const path = filePath.replace(/^\/+/, '');
  const dir = cacheDirFor(name, version);
  const cached = await readContentCache(dir, filePath);
  if (cached !== null) return cached;
  const attempts = [];
  for (const template of CONFIG.mirrors) {
    const url = template
      .replaceAll('{name}', name)
      .replaceAll('{version}', version)
      .replaceAll('{path}', path);
    try {
      const text = await fetchText(url);
      await writeContentCache(dir, filePath, text);
      return text;
    } catch (err) {
      attempts.push(`${new URL(url).host}: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
    }
  }
  const allMiss = attempts.every((a) => a.includes('(HTTP 404)'));
  if (allMiss) {
    throw error('not_found', `File not found in ${name}@${version}: ${path}`);
  }
  throw error('http', `All mirrors failed for ${name}@${version}/${path}. Attempts: ${attempts.join(' | ')}`);
}

// ─── Disk cache: XDG cache dir, keyed by immutable name@version ──────────────

/** Oversized payloads skip the disk cache (still served over the network). */
const MAX_DISK_FILE_BYTES = 1024 * 1024;

/** Resolved lazily so hosts and tests can point XDG_CACHE_HOME elsewhere. */
function cacheRoot() {
  if (process.env.LIBPEEK_NO_CACHE) return null;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'libpeek');
}

/** Directory for a target, or null when the key (or the disk cache) is unusable. */
function cacheDirFor(name, version) {
  const root = cacheRoot();
  if (!root) return null;
  // Names follow the registry rules (PACKAGE_NAME_RE) and versions are exact
  // semver (EXACT_VERSION_RE); both forbid ".." and stray separators, so the
  // joined directory cannot escape the cache root.
  if (!PACKAGE_NAME_RE.test(name) || !EXACT_VERSION_RE.test(version)) return null;
  return join(root, `${name}@${version}`);
}

async function readTreeCache(dir) {
  if (!dir) return null;
  try {
    // v1 caches stored string[]; upgrade them in place to {path, sizeBytes} entries.
    const raw = JSON.parse(await readFile(join(dir, 'tree.json'), 'utf8'));
    const entries = (Array.isArray(raw) ? raw : []).map((f) => (typeof f === 'string' ? { path: f } : f));
    if (entries.length > 0 && entries.every((f) => f && typeof f.path === 'string')) {
      await touchDir(dir);
      return entries;
    }
  } catch { /* miss, unreadable, or unknown shape - fall through to the network */ }
  return null;
}

async function writeTreeCache(dir, files) {
  if (!dir) return;
  try {
    const raw = JSON.stringify(files);
    if (raw.length > MAX_DISK_FILE_BYTES) return;
    const file = join(dir, 'tree.json');
    const tmp = `${file}.tmp${process.pid}`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, raw);
    await rename(tmp, file);
    noteDiskWrite(raw.length);
    await touchDir(dir);
    await evictIfNeeded();
  } catch { /* best effort - cache is a pure optimization */ }
}

/** Agent-provided paths must never escape <dir>/content/ via ".." segments. */
function contentCachePath(dir, path) {
  if (!dir) return null;
  const rel = path.replace(/^\/+|\/+$/g, '');
  if (rel === '' || rel.split('/').includes('..')) return null;
  return join(dir, 'content', rel);
}

async function readContentCache(dir, path) {
  const file = contentCachePath(dir, path);
  if (!file) return null;
  try {
    const content = await readFile(file, 'utf8');
    await touchDir(dir);
    return content;
  } catch {
    return null;
  }
}

async function writeContentCache(dir, path, content) {
  const file = contentCachePath(dir, path);
  if (!file || content.length > MAX_DISK_FILE_BYTES) return;
  try {
    const tmp = `${file}.tmp${process.pid}`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, content);
    await rename(tmp, file);
    noteDiskWrite(content.length);
    await touchDir(dir);
    await evictIfNeeded();
  } catch { /* best effort - cache is a pure optimization */ }
}

// ─── LRU eviction: whole-package dirs, oldest mtime first ────────────────────

/** Size bookkeeping per cache root; a root change (or unset) forces a re-scan. */
let diskScanState = null;

/** Cheap scan short-circuit: only trust the tally while the cache root is unchanged. */
function noteDiskWrite(bytes) {
  const root = cacheRoot();
  if (diskScanState && diskScanState.root === root) diskScanState.approx += bytes;
}

function diskCacheMaxBytes() {
  const mb = Number(process.env.LIBPEEK_CACHE_MAX_MB);
  const mega = Number.isFinite(mb) && mb >= 0 ? mb : 256;
  return mega * 1024 * 1024;
}

/** Refresh a package dir's mtime so eviction ranks it as recently used. */
async function touchDir(path) {
  try {
    const now = new Date();
    await utimes(path, now, now);
  } catch { /* best effort */ }
}

async function dirSize(path) {
  let total = 0;
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      total += (await stat(join(entry.parentPath ?? entry.path, entry.name))).size;
    }
  }
  return total;
}

/**
 * Keep the cache root within LIBPEEK_CACHE_MAX_MB (default 256): scan its
 * package directories (forced on the first write after a cache-root change,
 * afterwards only when the approximate total crosses the limit) and evict
 * whole directories, oldest mtime first, down to 90% of the limit. Reads
 * refresh the mtime; eviction is transparent - evicted targets just refetch.
 */
async function evictIfNeeded() {
  const root = cacheRoot();
  if (!root) return;
  if (diskScanState && diskScanState.root === root && diskScanState.approx < diskCacheMaxBytes()) return;
  try {
    let total = 0;
    const dirs = [];
    for (const name of await readdir(root)) {
      const dir = join(root, name);
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      dirs.push({ dir, mtime: st.mtimeMs });
      total += await dirSize(dir);
    }
    if (total > diskCacheMaxBytes()) {
      const floor = diskCacheMaxBytes() * 0.9;
      dirs.sort((a, b) => a.mtime - b.mtime);
      for (const { dir } of dirs) {
        if (total <= floor) break;
        const size = await dirSize(dir);
        await rm(dir, { recursive: true, force: true });
        total -= size;
      }
    }
    diskScanState = { root, approx: total };
  } catch { /* best effort */ }
}

// ─── Open: per-target virtual-fs cache ───────────────────────────────────────

const opened = new Map(); // 'name@version' -> VirtualFs

/**
 * Open (or reuse) the package's virtual fs for name@version: the file tree
 * plus a contents cache that fills as files are loaded. Long-lived hosts
 * get a cross-call cache; short-lived shim processes reuse it within one
 * invocation.
 * @param {string} name
 * @param {string} version
 * @returns {Promise<import('./vfs.mjs').VirtualFs>}
 */
export async function open(name, version) {
  const key = `${name}@${version}`;
  let fs = opened.get(key);
  if (!fs) {
    fs = {
      name,
      version,
      files: await listFiles(name, version),
      contents: new Map(),
    };
    fs.load = async (path) => {
      const p = path.startsWith('/') ? path : `/${path}`;
      if (fs.contents.has(p)) return fs.contents.get(p);
      const content = await fetchPackageFile(name, version, p);
      fs.contents.set(p, content);
      return content;
    };
    opened.set(key, fs);
  }
  return fs;
}
