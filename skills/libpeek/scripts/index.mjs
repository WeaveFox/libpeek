/**
 * libpeek entry point: MCP-shaped tool functions (one args object in, one
 * JSON result out) + a shim to run them from a shell:
 *   node index.mjs <tool> <args...|json>
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { error, list, glob, read, grep } from './vfs.mjs';
import {
  CONFIG,
  assertPackageName,
  splitPackageArg,
  resolveVersion,
  open,
} from './npm.mjs';

/** Brand identity lives here - the only module that knows the product name. */
const LIBPEEK_VERSION = '0.2.0';
CONFIG.ua = `libpeek/${LIBPEEK_VERSION} (+https://github.com/WeaveFox/libpeek)`;

/**
 * Resolve "name" / "name@spec" plus an optional version into an exact target.
 * @param {string} packageArg - "react", "react@19.1.0", "@scope/pkg@^1"
 * @param {string} [version] - exact version, dist-tag, or semver range; wins over the inline spec
 * @returns {Promise<{name: string, version: string, specUsed: string}>}
 */
async function resolveTarget(packageArg, version) {
  const { name, spec } = splitPackageArg(String(packageArg ?? ''));
  assertPackageName(name);
  // Priority: explicit version > inline "name@spec" > latest
  const effective = version ?? spec ?? 'latest';
  const resolved = await resolveVersion(name, effective);
  return { name, version: resolved, specUsed: effective };
}

/** Tool functions: one args object in, one plain object out. */
export const tools = {
  /**
   * List all files in a package (leading "/", sorted) with their sizes.
   * @param {object} args
   * @param {string} args.package - package name; "pkg@spec" inline form allowed
   * @param {string} [args.version] - exact version, dist-tag, or semver range; wins over the inline spec
   * @returns {Promise<{package: string, version: string, spec: string, count: number, files: {path: string, sizeBytes?: number}[]}>}
   */
  async list(args = {}) {
    const target = await resolveTarget(args.package, args.version);
    const fs = await open(target.name, target.version);
    const result = list(fs);
    return { package: target.name, version: target.version, spec: target.specUsed, ...result };
  },

  /**
   * Match file entries: wildcards (* ? **, case-insensitive) or fuzzy bare queries.
   * @param {object} args
   * @param {string} args.package - package name; "pkg@spec" inline form allowed
   * @param {string[]|string} args.patterns - patterns array, or one comma-separated string
   * @param {string} [args.version] - exact version, dist-tag, or semver range
   * @returns {Promise<{package: string, version: string, spec: string, patterns: string[], count: number, matches: {path: string, sizeBytes?: number}[]}>}
   */
  async glob(args = {}) {
    const patterns = Array.isArray(args.patterns)
      ? args.patterns
      : String(args.patterns ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (patterns.length === 0) {
      throw error('usage', 'glob requires "patterns" (array or comma-separated string)');
    }
    const target = await resolveTarget(args.package, args.version);
    const fs = await open(target.name, target.version);
    const { matches, count } = glob(fs, { patterns });
    return {
      package: target.name,
      version: target.version,
      spec: target.specUsed,
      patterns,
      count,
      matches,
    };
  },

  /**
   * Read one file with line numbers; caps at 2000 lines / 2000 chars per line / 50 KB.
   * @param {object} args
   * @param {string} args.package - package name; "pkg@spec" inline form allowed
   * @param {string} args.path - file path within the package
   * @param {string} [args.version] - exact version, dist-tag, or semver range
   * @param {number} [args.offset=1] - 1-indexed start line
   * @param {number} [args.limit=2000] - max lines returned
   * @returns {Promise<{package: string, version: string, spec: string, path: string, startLine: number, endLine: number, totalLines: number, sizeBytes: number, truncated: boolean, content: string}>}
   */
  async read(args = {}) {
    if (!args.path) throw error('usage', 'read requires "path"');
    if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 1)) {
      throw error('usage', '"offset" must be an integer >= 1');
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
      throw error('usage', '"limit" must be an integer >= 1');
    }
    const target = await resolveTarget(args.package, args.version);
    const fs = await open(target.name, target.version);
    const result = await read(fs, { path: args.path, offset: args.offset, limit: args.limit });
    return { package: target.name, version: target.version, spec: target.specUsed, ...result };
  },

  /**
   * Regex-search file contents (case-insensitive by default, \b with wholeWord).
   * Downloads at most maxFiles (default 30) files per call starting at
   * fileOffset; returns at most 50 match lines. truncated means "the result
   * is incomplete": hit lines were capped or files remained unsearched.
   * @param {object} args
   * @param {string} args.package - package name; "pkg@spec" inline form allowed
   * @param {string} args.pattern - JS regex applied to each line
   * @param {string} [args.version] - exact version, dist-tag, or semver range
   * @param {string|Array<string>} [args.include] - glob(s) scoping searched files, e.g. every ".d.ts" under "dist", or several: "a-*.js, b-*.js"
   * @param {boolean} [args.wholeWord=false] - wrap the pattern in word boundaries
   * @param {number} [args.maxFiles=30] - max files downloaded per call
   * @param {number} [args.fileOffset=1] - 1-indexed candidate to start from (candidates keep a stable order)
   * @returns {Promise<{package: string, version: string, spec: string, count: number, truncated: boolean, filesSearched: number, filesSkipped: number, matches: {file: string, line: number, text: string}[], hint?: string}>}
   */
  async grep(args = {}) {
    if (!args.pattern) throw error('usage', 'grep requires "pattern"');
    let regex;
    try {
      regex = new RegExp(args.wholeWord ? `\\b${args.pattern}\\b` : args.pattern, 'gi'); // case-insensitive: one loose pass beats re-guessing
    } catch {
      throw error('invalid_regex', `Invalid regular expression: "${args.pattern}"`);
    }
    let include;
    if (args.include !== undefined) {
      if (typeof args.include !== 'string' && !Array.isArray(args.include)) {
        throw error('usage', '"include" must be a glob string (comma-separated for several) or an array of them');
      }
      include = Array.isArray(args.include)
        ? args.include.map((p) => String(p).trim()).filter(Boolean)
        : args.include.split(',').map((s) => s.trim()).filter(Boolean);
      if (include.length === 0) {
        throw error('usage', '"include" must contain at least one glob pattern');
      }
    }
    if (args.maxFiles !== undefined && (!Number.isInteger(args.maxFiles) || args.maxFiles < 1)) {
      throw error('usage', '"maxFiles" must be an integer >= 1');
    }
    if (args.fileOffset !== undefined && (!Number.isInteger(args.fileOffset) || args.fileOffset < 1)) {
      throw error('usage', '"fileOffset" must be an integer >= 1');
    }
    const target = await resolveTarget(args.package, args.version);
    const fs = await open(target.name, target.version);
    const result = await grep(fs, { regex, include, maxFiles: args.maxFiles, fileOffset: args.fileOffset });
    return { package: target.name, version: target.version, spec: target.specUsed, ...result };
  },
};

// ─── Direct-execution shim (tool + args, no flag parsing) ────────────────────

/** Positional sugar: node index.mjs <tool> <package> [more positional args]. */
const POSITIONAL = {
  list: (rest) => ({ package: rest[0] }),
  glob: (rest) => ({ package: rest[0], patterns: rest.slice(1) }),
  read: (rest) => ({ package: rest[0], path: rest[1] }),
  grep: (rest) => ({ package: rest[0], pattern: rest[1] }),
};

function runShim() {
  const [tool, ...rest] = process.argv.slice(2);
  const call = async () => {
    if (!tool || !tools[tool]) {
      const names = Object.keys(tools).join(', ');
      throw error(
        'usage',
        `Unknown tool "${tool ?? ''}". Available: ${names}. Call as: node index.mjs <tool> '<args JSON object>' or with positional args.`,
      );
    }
    const first = rest[0];
    let args;
    if (first !== undefined && /^\s*\{/.test(first)) {
      try {
        args = JSON.parse(first);
      } catch {
        throw error('usage', 'Arguments must be a single JSON object, e.g. {"package":"react","path":"package.json"}');
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw error('usage', 'Arguments must be a JSON object');
      }
    } else {
      args = POSITIONAL[tool](rest);
    }
    return tools[tool](args);
  };

  call().then(
    (result) => process.stdout.write(JSON.stringify(result) + '\n'),
    (err) => {
      // Expected failures carry the `expected` marker + a code; anything else is a bug.
      const payload =
        err?.expected === true
          ? { error: true, code: err.code, message: err.message }
          : { error: true, code: 'internal', message: err?.message ?? String(err), stack: err?.stack };
      process.stdout.write(JSON.stringify(payload) + '\n');
      process.exit(1);
    },
  );
}

// Only run the shim when invoked directly (works through skill symlinks too).
const invoked = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : null;
if (invoked === import.meta.url) {
  runShim();
}
