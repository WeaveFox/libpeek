#!/usr/bin/env node
/**
 * libpeek - read npm package source without installing it.
 *
 * One auditable file. Zero runtime dependencies. Read-only HTTP only:
 * every byte comes from public CDNs (packument + file trees + file contents),
 * nothing is executed, nothing is written to disk, no shell is spawned.
 *
 * Commands:
 *   list <package>                     List all file paths in the package
 *   glob <package> <patterns...>       Match file paths (wildcards or fuzzy)
 *   read <package> <path>              Read a file (line numbers, truncation)
 *   grep <package> <pattern>           Regex-search file contents
 *
 * Output: compact JSON on stdout. Errors are JSON too: {"error":true,...}.
 *
 * Semantics intentionally mirror the read_file/glob/grep tools used by coding
 * agents (line numbers, 2000-line/50KB read cap, 30-file grep cap) so an agent
 * can treat a remote package like a read-only filesystem.
 *
 * Notes on inlined replacements (this file has no dependencies by design):
 * - semver: a pragmatic subset (^ ~ >= > < <= = x-ranges || hyphen ranges).
 *   Sufficient for dependency ranges; documented edge cases in references/usage.md.
 * - glob: ** / * / ? matcher (case-insensitive), plus a fuzzy subsequence
 *   matcher for bare queries (a tiny stand-in for picomatch + uFuzzy).
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const CLI_VERSION = '0.1.0';
const USER_AGENT = `libpeek/${CLI_VERSION} (skill; +https://github.com/WeaveFox/libpeek)`;

// ─── Configuration ───────────────────────────────────────────────────────────

/** Packument endpoints (version resolution). Configurable for private/mirror registries. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * File-content mirror chains, tried in order. Placeholders: {name} {version} {path}.
 * intl: unpkg first (global edge), jsDelivr fallback.
 * cn:   npmmirror first (fast in China; 403s for some packages fall through), then intl.
 */
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

// Limits aligned with agent file tools (read_file / grep).
const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = '... (line truncated to 2000 chars)';
const MAX_BYTES = 50 * 1024;
const MAX_GREP_DOWNLOAD_FILES = 30;
const MAX_GREP_RESULTS = 50;
const GREP_CONCURRENCY = 8;

/** Binary files: skipped by grep, refused by read. */
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.mp3', '.wav',
  '.pdf', '.zip', '.gz',
];

/** Exact semver (no resolution needed against the registry). */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** npm package name: optional @scope/name. Guards every URL we build. */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/** Per-invocation config, filled in main(). Single-shot process: globals are fine. */
const CONFIG = {
  registry: DEFAULT_REGISTRY,
  mirrors: MIRRORS_INTL,
  timeoutMs: 10000,
  pretty: false,
  projectDir: null, // directory whose package.json provides declared versions
  noProject: false,
};

// ─── Errors & output ─────────────────────────────────────────────────────────

class PeekError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, CONFIG.pretty ? 2 : 0) + '\n');
}

function fail(err) {
  const payload =
    err instanceof PeekError
      ? { error: true, code: err.code, message: err.message }
      : { error: true, code: 'internal', message: err?.message ?? String(err) };
  process.stdout.write(JSON.stringify(payload, null, CONFIG.pretty ? 2 : 0) + '\n');
  process.exit(1);
}

function usageError(message) {
  return new PeekError('usage', `${message}\nRun with --help for usage.`);
}

const HELP = `libpeek ${CLI_VERSION} - read npm package source without installing.

Usage:
  node libpeek.mjs <command> <package> [args...] [options]

Commands:
  list <package>                    List all file paths in the package
  glob <package> <patterns...>      Match file paths; wildcards (* ? **) or
                                    fuzzy bare queries (e.g. "arrow-left")
  read <package> <path>             Read a file with line numbers
  grep <package> <pattern>          Regex-search file contents

Options:
  --version <spec>     Exact version, dist-tag, or semver range.
                       Default: the version declared in ./package.json
                       (dependencies/devDependencies), falling back to latest.
  --include <glob>     grep: limit searched files, e.g. "dist/**/*.d.ts"
  --whole-word         grep: whole-word match
  --max-files <n>      grep: max files downloaded per call (default 30)
  --offset <n>         read: 1-indexed start line
  --limit <n>          read: max lines (default 2000)
  --mirror <mode>      File mirror chain: "intl" (default) or "cn" (China加速)
  --registry <url>     Packument registry override (default registry.npmjs.org)
  --project <dir>      Directory for version alignment (default: cwd)
  --no-project         Disable version alignment from ./package.json
  --timeout <ms>       HTTP timeout (default 10000)
  --pretty             Pretty-print JSON output
  -h, --help           Show this help

Environment: LIBPEAK_REGISTRY, LIBPEAK_MIRROR=intl|cn, LIBPEAK_FILE_MIRRORS
(comma-separated URL templates with {name}/{version}/{path}), LIBPEAK_TIMEOUT.

Safety: read-only HTTP against public CDNs. Zero dependencies, no code
execution, no shell. See references/security.md.`;

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
          'user-agent': USER_AGENT,
          // Abbreviated packument: same dist-tags + version keys, far smaller
          // for large packages. Plain JSON endpoints ignore it.
          accept: 'application/vnd.npm.install-v1+json, application/json',
        },
      });
    } catch (err) {
      throw new PeekError('http', `Network error for ${url}: ${err?.cause?.message ?? err.message}`);
    }
    if (!res.ok) {
      const err = new PeekError('http', `HTTP ${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
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
    throw new PeekError('http', `Invalid JSON response from ${url}`);
  }
}

// ─── Minimal semver (pragmatic subset) ───────────────────────────────────────

function parseVersion(raw) {
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
function compareVersions(a, b) {
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

/**
 * Parse one comparator group (no "||"): whitespace-separated comparators,
 * plus hyphen ranges ("1.2.3 - 2.0.0"). Returns an array of {op, ver} or
 * [] meaning "any version". Throws PeekError('invalid_range') on garbage.
 */
function parseComparatorGroup(str) {
  const tokens = str.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens.length === 1 && ['*', 'x', 'X', ''].includes(tokens[0]))) return [];

  // Hyphen range: <lo> - <hi>
  const hyphenIdx = tokens.indexOf('-');
  if (hyphenIdx !== -1) {
    if (hyphenIdx !== 1 || tokens.length !== 3) {
      throw new PeekError('invalid_range', `Invalid hyphen range: "${str}"`);
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
      throw new PeekError('invalid_range', `Invalid version range token: "${token}"`);
    }
    const parts = parseXRange(rest); // {major, minor, patch} with null = wildcard
    if (parts === null) {
      throw new PeekError('invalid_range', `Invalid version range token: "${token}"`);
    }
    comparators.push(...desugar(op, parts));
  }
  return comparators;
}

/** Parse "1.2.x" / "1" / "*" style tokens into {major,minor,patch} (null = wildcard). */
function parseXRange(token) {
  if (token === '*' || token === 'x' || token === 'X') return { major: null, minor: null, patch: null };
  const parts = token.split('.');
  if (parts.length > 3) return null;
  const out = { major: null, minor: null, patch: null };
  const keys = ['major', 'minor', 'patch'];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'x' || p === 'X' || p === '*') break; // wildcards imply the rest is wildcard
    if (!/^\d+$/.test(p)) return null;
    out[keys[i]] = Number(p);
  }
  return out;
}

/**
 * Desugar one token + operator into comparators.
 * Boundary convention (subset of semver): missing levels fill with 0 on the
 * lower bound; the exclusive upper bound increments the first missing level.
 */
function desugar(op, { major: M, minor: m, patch: p }) {
  if (M === null) return []; // "*" -> any

  if (op === '^') {
    const lower = { major: M, minor: m ?? 0, patch: p ?? 0 };
    let upper;
    if (m === null) upper = { major: M + 1, minor: 0, patch: 0 };
    else if (p === null) upper = M === 0 ? { major: 0, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0 };
    else if (M > 0) upper = { major: M + 1, minor: 0, patch: 0 };
    else if (m > 0) upper = { major: 0, minor: m + 1, patch: 0 };
    else upper = { major: 0, minor: 0, patch: p + 1 };
    return [cmp('>=', lower), cmp('<', upper)];
  }
  if (op === '~') {
    const lower = { major: M, minor: m ?? 0, patch: p ?? 0 };
    const upper = m === null ? { major: M + 1, minor: 0, patch: 0 } : { major: M, minor: m + 1, patch: 0 };
    return [cmp('>=', lower), cmp('<', upper)];
  }
  if (op === '>' || op === '<' || op === '<=' || op === '>=') {
    const hasMinor = m !== null;
    const hasPatch = p !== null;
    switch (op) {
      case '>':
        // >1.2 := >=1.3.0 ; >1 := >=2.0.0 ; full version stays as-is
        return [cmp('>=', hasMinor ? { major: M, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0 })];
      case '<':
        // <1.2 := <1.2.0
        return [cmp('<', { major: M, minor: m ?? 0, patch: p ?? 0 })];
      case '>=':
        return [cmp('>=', { major: M, minor: m ?? 0, patch: p ?? 0 })];
      case '<=':
        // <=1.2 := <1.3.0 (2.0.0-0 boundary edge accepted)
        return [cmp('<', hasMinor ? { major: M, minor: m + 1, patch: 0 } : { major: M + 1, minor: 0, patch: 0 })];
      default:
        break;
    }
  }
  // No operator: full version -> exact; partial -> half-open x-range
  if (m !== null && p !== null) return [cmp('=', { major: M, minor: m, patch: p })];
  if (m !== null) return [cmp('>=', { major: M, minor: m, patch: 0 }), cmp('<', { major: M, minor: m + 1, patch: 0 })];
  return [cmp('>=', { major: M, minor: 0, patch: 0 }), cmp('<', { major: M + 1, minor: 0, patch: 0 })];
}

/** Hyphen-range endpoint: bare partial version as >=lo / <=hi(with upper bound). */
function desugarLoose(token, sideOp) {
  const parts = parseXRange(token);
  if (parts === null || parts.major === null) {
    throw new PeekError('invalid_range', `Invalid hyphen range endpoint: "${token}"`);
  }
  const { major: M, minor: m, patch: p } = parts;
  if (sideOp === '>=') return [cmp('>=', { major: M, minor: m ?? 0, patch: p ?? 0 })];
  // Upper: "2" -> <3.0.0, "2.3" -> <2.4.0, "2.3.4" -> <=2.3.4
  if (m === null) return [cmp('<', { major: M + 1, minor: 0, patch: 0 })];
  if (p === null) return [cmp('<', { major: M, minor: m + 1, patch: 0 })];
  return [cmp('<=', { major: M, minor: m, patch: p })];
}

function cmp(op, ver) {
  // Comparator bounds always carry a prerelease array so compareVersions()
  // and satisfies() can treat them exactly like parsed versions.
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

function maxSatisfying(versionList, spec) {
  const groups = spec
    .split('||')
    .map((g) => parseComparatorGroup(g.trim()))
    .filter((g) => g !== null);
  if (groups.length === 0) throw new PeekError('invalid_range', `Invalid version range: "${spec}"`);

  let best = null;
  for (const raw of versionList) {
    const v = parseVersion(raw);
    if (!v || !satisfies(v, groups)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best ? best.raw : null;
}

// ─── Registry & package files ────────────────────────────────────────────────

function assertPackageName(name) {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new PeekError('bad_name', `Invalid npm package name: "${name}"`);
  }
}

/**
 * Accept "react", "react@19.1.0", "@scope/pkg" and "@scope/pkg@19.1.0".
 * The trailing @spec (exact version, dist-tag, or range) overrides the
 * project manifest alignment but loses to an explicit --version flag.
 */
function splitPackageArg(arg) {
  const atIndex = arg.startsWith('@') ? arg.indexOf('@', 1) : arg.indexOf('@');
  if (atIndex === -1) return { name: arg, spec: undefined };
  return { name: arg.slice(0, atIndex), spec: arg.slice(atIndex + 1) || undefined };
}

/**
 * Resolve latest / dist-tag / semver range to an exact version.
 * Exact versions skip the registry entirely.
 */
async function resolveVersion(name, spec) {
  if (EXACT_VERSION_RE.test(spec)) return spec;

  const packument = await fetchJson(`${CONFIG.registry}/${name}`);
  const distTags = packument?.['dist-tags'];
  if (distTags && typeof distTags === 'object' && distTags[spec] !== undefined) {
    return distTags[spec];
  }
  if (spec === 'latest') {
    throw new PeekError('no_version', `Package ${name} has no "latest" dist-tag`);
  }
  const versions = Object.keys(packument?.versions ?? {});
  if (versions.length === 0) {
    throw new PeekError('no_version', `No published versions found for ${name}`);
  }
  const best = maxSatisfying(versions, spec);
  if (best) return best;
  throw new PeekError('no_version', `No version of ${name} matches "${spec}" (available: ${versions.length})`);
}

/** jsDelivr Data API: nested tree whose `name`s are relative to their parent. */
function flattenFileTree(entries, parentPath = '') {
  const files = [];
  for (const entry of entries ?? []) {
    const path = `${parentPath}/${entry.name}`;
    if (entry.type === 'directory') {
      files.push(...flattenFileTree(entry.files, path));
    } else {
      files.push(path);
    }
  }
  return files;
}

async function listFiles(name, version) {
  const url = JSDELIVR_DATA_API.replaceAll('{name}', name).replaceAll('{version}', version);
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.files)) {
    throw new PeekError('http', `Unexpected file-tree response for ${name}@${version}`);
  }
  return flattenFileTree(data.files).sort();
}

/**
 * Fetch one file, trying the configured mirror chain in order.
 * 404/403 fall through to the next mirror; only an all-miss is an error
 * (all-404 => the file does not exist in that version's tarball).
 */
async function fetchPackageFile(name, version, filePath) {
  const path = filePath.replace(/^\/+/, '');
  const attempts = [];
  for (const template of CONFIG.mirrors) {
    const url = template
      .replaceAll('{name}', name)
      .replaceAll('{version}', version)
      .replaceAll('{path}', path);
    try {
      return await fetchText(url);
    } catch (err) {
      attempts.push(`${new URL(url).host}: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
    }
  }
  const allMiss = attempts.every((a) => a.includes('(HTTP 404)'));
  if (allMiss) {
    throw new PeekError('not_found', `File not found in ${name}@${version}: ${path}`);
  }
  throw new PeekError('http', `All mirrors failed for ${name}@${version}/${path}. Attempts: ${attempts.join(' | ')}`);
}

// ─── Path matching (inline replacement for picomatch + uFuzzy) ───────────────

/**
 * Wildcard matcher: ** crosses "/", * and ? stay within one segment.
 * Case-insensitive, like the picomatch({nocase}) usage it replaces.
 */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        let j = i + 2;
        if (pattern[j] === '/') {
          re += '(?:.*/)?'; // "**/" matches zero or more segments
          i = j;
        } else {
          re += '.*'; // bare "**" matches anything
          i = j - 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Fuzzy subsequence score: consecutive and boundary hits rank higher. */
function fuzzyScore(hay, needle) {
  let qi = 0;
  let score = 0;
  let lastHit = -2;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] === needle[qi]) {
      score += i === lastHit + 1 ? 3 : 1;
      if (i === 0 || '/._-'.includes(hay[i - 1])) score += 2;
      lastHit = i;
      qi++;
    }
  }
  return qi === needle.length ? score : null;
}

/**
 * Match package paths against one pattern.
 * Wildcards -> glob; bare text -> fuzzy (falls back to substring match);
 * relative patterns match paths with the leading "/" stripped.
 */
function matchPattern(paths, pattern) {
  const relative = !pattern.startsWith('/');
  // Match against slash-stripped paths for relative patterns, return originals.
  const matchTargets = relative ? paths.map((p) => (p.startsWith('/') ? p.slice(1) : p)) : paths;
  if (pattern.includes('*') || pattern.includes('?')) {
    const re = globToRegExp(pattern);
    return paths.filter((_, i) => re.test(matchTargets[i]));
  }

  const q = pattern.toLowerCase();
  const scored = [];
  for (let i = 0; i < matchTargets.length; i++) {
    const score = fuzzyScore(matchTargets[i].toLowerCase(), q);
    if (score !== null) scored.push({ index: i, score });
  }
  if (scored.length === 0) {
    // Substring fallback keeps bare-name queries useful on huge trees.
    return paths.filter((_, i) => matchTargets[i].toLowerCase().includes(q));
  }
  scored.sort((a, b) => b.score - a.score || paths[a.index].length - paths[b.index].length);
  return scored.map((s) => paths[s.index]);
}

function matchGlobs(paths, patterns) {
  const seen = new Set();
  const matches = [];
  for (const pattern of patterns) {
    for (const path of matchPattern(paths, pattern)) {
      if (!seen.has(path)) {
        seen.add(path);
        matches.push(path);
      }
    }
  }
  return matches;
}

// ─── Version alignment from the user's project ───────────────────────────────

/**
 * Read the version spec declared for `name` in the nearest ./package.json
 * (or --project dir). This keeps results aligned with what is actually
 * installed locally - the whole point of "ground truth".
 */
function readProjectVersion(name) {
  if (CONFIG.noProject) return undefined;
  const manifest = CONFIG.projectDir ? join(CONFIG.projectDir, 'package.json') : 'package.json';
  try {
    if (!existsSync(manifest)) return undefined;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    return (
      pkg.dependencies?.[name] ??
      pkg.devDependencies?.[name] ??
      pkg.peerDependencies?.[name] ??
      pkg.optionalDependencies?.[name] ??
      undefined
    );
  } catch {
    return undefined; // malformed manifest -> fall back to latest
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function resolveTarget(packageName, spec) {
  assertPackageName(packageName);
  const effective = spec ?? readProjectVersion(packageName) ?? 'latest';
  const version = await resolveVersion(packageName, effective);
  return { package: packageName, version, specUsed: effective };
}

function isBinaryPath(path) {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function cmdList(packageName, opts) {
  const target = await resolveTarget(packageName, opts.version);
  const files = await listFiles(target.package, target.version);
  emit({ package: target.package, version: target.version, spec: target.specUsed, count: files.length, files });
}

async function cmdGlob(packageName, patterns, opts) {
  if (patterns.length === 0) throw usageError('glob requires at least one pattern');
  const target = await resolveTarget(packageName, opts.version);
  const files = await listFiles(target.package, target.version);
  const matches = matchGlobs(files, patterns);
  emit({
    package: target.package,
    version: target.version,
    spec: target.specUsed,
    patterns,
    count: matches.length,
    matches,
  });
}

async function cmdRead(packageName, filePath, opts) {
  if (!filePath) throw usageError('read requires a file path');
  if (filePath.includes('?') || filePath.includes('#')) {
    throw new PeekError('bad_path', `Invalid file path: "${filePath}"`);
  }
  if (isBinaryPath(filePath)) {
    throw new PeekError('binary_file', `Cannot read binary file: ${filePath}`);
  }
  const offset = opts.offset ?? 1;
  const limit = opts.limit ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(offset) || offset < 1) throw usageError('--offset must be an integer >= 1');
  if (!Number.isInteger(limit) || limit < 1) throw usageError('--limit must be an integer >= 1');

  const target = await resolveTarget(packageName, opts.version);
  const content = await fetchPackageFile(target.package, target.version, filePath);

  const lines = content.split('\n');
  const totalLines = lines.length;
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new PeekError('bad_path', `Offset ${offset} is out of range for ${filePath} (${totalLines} lines)`);
  }

  const out = [];
  let bytes = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;

  for (let i = offset - 1; i < totalLines; i++) {
    if (out.length >= limit) {
      hasMoreLines = true;
      break;
    }
    let line = lines[i];
    if (line.length > MAX_LINE_LENGTH) {
      line = line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX;
    }
    const lineSize = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0);
    if (bytes + lineSize > MAX_BYTES) {
      truncatedByBytes = true;
      hasMoreLines = true;
      break;
    }
    out.push(line);
    bytes += lineSize;
  }

  const endLine = offset + out.length - 1;
  const truncated = hasMoreLines || truncatedByBytes;

  let body = out.map((line, i) => `${i + offset}: ${line}`).join('\n');
  if (truncatedByBytes) {
    body += `\n\n(Output capped at 50 KB. Showing lines ${offset}-${endLine}. Use --offset ${endLine + 1} to continue.)`;
  } else if (hasMoreLines) {
    body += `\n\n(Showing lines ${offset}-${endLine} of ${totalLines}. Use --offset ${endLine + 1} to continue.)`;
  } else {
    body += `\n\n(End of file - total ${totalLines} lines)`;
  }

  emit({
    package: target.package,
    version: target.version,
    spec: target.specUsed,
    path: filePath,
    startLine: offset,
    endLine,
    totalLines,
    sizeBytes: bytes,
    truncated,
    content: body,
  });
}

async function cmdGrep(packageName, pattern, opts) {
  if (!pattern) throw usageError('grep requires a pattern');
  let regex;
  try {
    const source = opts.wholeWord ? `\\b${pattern}\\b` : pattern;
    regex = new RegExp(source, 'gi'); // case-insensitive: one loose pass beats re-guessing
  } catch {
    throw new PeekError('invalid_regex', `Invalid regular expression: "${pattern}"`);
  }

  const target = await resolveTarget(packageName, opts.version);
  const files = await listFiles(target.package, target.version);

  let candidates = files;
  let hint;
  if (opts.include) {
    candidates = matchGlobs(files, [opts.include]);
    if (candidates.length === 0) {
      // "No files matched" must never read as "no content matched".
      const topLevelDirs = [
        ...new Set(
          files
            .map((f) => f.split('/').slice(0, -1).join('/'))
            .filter(Boolean)
            .map((dir) => dir.split('/').slice(0, 3).join('/')),
        ),
      ].slice(0, 10);
      hint = `include "${opts.include}" matched no files in ${target.package}. Package paths carry full directory prefixes (e.g. ${topLevelDirs.join(', ')}). Run "glob" first to locate files, or drop --include to search the whole package.`;
    }
  }
  if (!hint) {
    candidates = candidates.filter((f) => !isBinaryPath(f));
  } else {
    candidates = [];
  }

  const maxFiles = opts.maxFiles ?? MAX_GREP_DOWNLOAD_FILES;
  const toSearch = candidates.slice(0, maxFiles);
  const filesSkipped = Math.max(candidates.length - maxFiles, 0);

  const contents = await fetchInBatches(toSearch, GREP_CONCURRENCY, (path) =>
    fetchPackageFile(target.package, target.version, path),
  );

  const fileMap = {};
  for (const [i, content] of contents.entries()) {
    if (content !== undefined) fileMap[toSearch[i]] = content;
  }

  const matches = [];
  let truncatedResults = false;
  outer: for (const [filePath, content] of Object.entries(fileMap)) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_RESULTS) {
        truncatedResults = true;
        break outer;
      }
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        const line = lines[i];
        const text = (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '...' : line).trim();
        matches.push({ file: filePath, line: i + 1, text });
      }
    }
  }

  const result = {
    package: target.package,
    version: target.version,
    spec: target.specUsed,
    count: matches.length,
    truncated: truncatedResults,
    filesSearched: Object.keys(fileMap).length,
    filesSkipped,
    matches,
  };
  if (hint) result.hint = hint;
  if (filesSkipped > 0 && !hint) {
    result.hint = `${filesSkipped} file(s) not searched (cap: ${maxFiles}). Narrow with --include, e.g. "dist/**/*.d.ts".`;
  }
  emit(result);
}

/** Bounded-concurrency mapper; per-item failures resolve to undefined. */
async function fetchInBatches(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch {
        results[i] = undefined; // single file failure must not kill the search
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        version: { type: 'string', short: 'v' },
        include: { type: 'string' },
        'whole-word': { type: 'boolean' },
        'max-files': { type: 'string' },
        offset: { type: 'string' },
        limit: { type: 'string' },
        mirror: { type: 'string' },
        registry: { type: 'string' },
        project: { type: 'string' },
        'no-project': { type: 'boolean' },
        timeout: { type: 'string' },
        pretty: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw usageError(err.message);
  }
}

function applyConfig(values) {
  if (values.registry) CONFIG.registry = values.registry.replace(/\/+$/, '');
  if (values.mirror === 'cn') CONFIG.mirrors = MIRRORS_CN;
  else if (values.mirror && values.mirror !== 'intl') throw usageError(`--mirror must be "intl" or "cn", got "${values.mirror}"`);
  if (process.env.LIBPEAK_MIRROR === 'cn' && values.mirror === undefined) CONFIG.mirrors = MIRRORS_CN;

  const envMirrors = process.env.LIBPEAK_FILE_MIRRORS;
  if (envMirrors && values.mirror === undefined) {
    CONFIG.mirrors = envMirrors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (CONFIG.mirrors.length === 0) throw usageError('LIBPEAK_FILE_MIRRORS is empty');
  }

  const timeout = values.timeout ?? process.env.LIBPEAK_TIMEOUT;
  if (timeout !== undefined) {
    const n = Number(timeout);
    if (!Number.isFinite(n) || n <= 0) throw usageError('--timeout must be a positive number');
    CONFIG.timeoutMs = n;
  }
  if (values['no-project']) CONFIG.noProject = true;
  else if (values.project) CONFIG.projectDir = isAbsolute(values.project) ? values.project : resolve(values.project);
  CONFIG.pretty = Boolean(values.pretty);
}

function toInt(values, key, flagName) {
  if (values[key] === undefined) return undefined;
  const n = Number(values[key]);
  if (!Number.isInteger(n) || n < 1) throw usageError(`${flagName} must be an integer >= 1`);
  return n;
}

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2));

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP + '\n');
    process.exit(values.help ? 0 : 1);
  }

  applyConfig(values);

  const [command, pkgArg, ...rest] = positionals;
  if (!pkgArg) throw usageError(`"${command}" requires a package name`);
  const { name: packageName, spec: inlineSpec } = splitPackageArg(pkgArg);
  const opts = {
    // Priority: explicit --version > inline "pkg@spec" > project manifest > latest
    version: values.version ?? inlineSpec,
    include: values.include,
    wholeWord: Boolean(values['whole-word']),
    maxFiles: toInt(values, 'max-files', '--max-files'),
    offset: toInt(values, 'offset', '--offset'),
    limit: toInt(values, 'limit', '--limit'),
  };

  switch (command) {
    case 'list':
      if (!packageName) throw usageError('list requires a package name');
      await cmdList(packageName, opts);
      break;
    case 'glob': {
      if (!packageName) throw usageError('glob requires a package name');
      const patterns = rest.flatMap((arg) => arg.split(',')).filter(Boolean);
      await cmdGlob(packageName, patterns, opts);
      break;
    }
    case 'read':
      if (!packageName) throw usageError('read requires a package name');
      await cmdRead(packageName, rest[0], opts);
      break;
    case 'grep':
      if (!packageName) throw usageError('grep requires a package name');
      await cmdGrep(packageName, rest[0], opts);
      break;
    default:
      throw usageError(`Unknown command: "${command}"`);
  }
}

main().catch(fail);
