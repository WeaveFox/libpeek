/**
 * Read-only virtual filesystem: list/glob/read/grep over a package fs
 * opened by the data source (see VirtualFs). Never touches the network -
 * fs.load() is injected by the data source.
 */

/**
 * Expected failure: err.expected tells the shim it is not a bug.
 */
export function error(code, message) {
  const err = new Error(message);
  err.expected = true;
  err.code = code;
  return err;
}

/**
 * The virtual filesystem of a package, built and cached by the data source.
 * Every vfs function takes it as the first argument.
 * @typedef {object} VirtualFs
 * @property {string} name - package name this fs belongs to
 * @property {string} version - resolved version
 * @property {Array<{path: string, sizeBytes?: number}>} files - file entries (leading "/", sorted); sizeBytes comes from the source tree
 * @property {Map<string, string>} contents - cached file contents, keyed by path
 * @property {(path: string) => Promise<string>} load - miss -> fetch -> cache into contents
 */

// Output limits, aligned with the read_file/grep tools used by coding agents.
const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const MAX_BYTES = 50 * 1024;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_DOWNLOAD_FILES = 30;
const GREP_CONCURRENCY = 8;
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.webm', '.mp3', '.wav',
  '.pdf', '.zip', '.gz',
];

/** VirtualFs paths all carry a leading "/" - accept both input forms. */
function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

function isBinaryPath(path) {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Wildcards: ** crosses "/", * and ? stay in one segment; case-insensitive. */
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
 * Pattern dispatch: wildcards -> glob; anchored literal paths -> substring
 * over full paths (exact files and directory prefixes, never fuzzy);
 * bare text -> exact basename first, then fuzzy over basenames; relative
 * patterns with "/" -> fuzzy over slash-stripped paths.
 */
function matchPattern(entries, pattern) {
  const paths = entries.map((e) => e.path);
  if (pattern.includes('*') || pattern.includes('?')) {
    // Anchored patterns match the full path; "/"-less ones match basenames
    // at any depth; relative patterns with "/" match slash-stripped paths.
    const matchTargets = pattern.startsWith('/')
      ? paths
      : !pattern.includes('/')
        ? paths.map((p) => p.slice(p.lastIndexOf('/') + 1))
        : paths.map((p) => (p.startsWith('/') ? p.slice(1) : p));
    const re = globToRegExp(pattern);
    return entries.filter((_, i) => re.test(matchTargets[i]));
  }
  if (pattern.startsWith('/')) {
    // An anchored literal path is exact intent: substring match over full
    // paths (so "/dir/" prefixes pull in whole folders), never fuzzy.
    const q = pattern.toLowerCase();
    return entries.filter((_, i) => paths[i].toLowerCase().includes(q));
  }

  // "/"-less patterns target file names; relative patterns with "/" target
  // the slash-stripped full path.
  const matchTargets = !pattern.includes('/')
    ? paths.map((p) => p.slice(p.lastIndexOf('/') + 1))
    : paths.map((p) => (p.startsWith('/') ? p.slice(1) : p));
  const q = pattern.toLowerCase();
  // Exact basename hit wins: a bare file name ("faCircleDown.js") reads as
  // intent, so it must not expand into fuzzy lookalikes in grep include.
  const exact = entries.filter((_, i) => matchTargets[i].toLowerCase() === q);
  if (exact.length > 0) return exact;
  const scored = [];
  for (let i = 0; i < matchTargets.length; i++) {
    const score = fuzzyScore(matchTargets[i].toLowerCase(), q);
    if (score !== null) scored.push({ index: i, score });
  }
  if (scored.length === 0) {
    // Substring fallback keeps bare-name queries useful on huge trees.
    return entries.filter((_, i) => matchTargets[i].toLowerCase().includes(q));
  }
  scored.sort((a, b) => b.score - a.score || paths[a.index].length - paths[b.index].length);
  return scored.map((s) => entries[s.index]);
}

/**
 * List the fs entries (ls semantics); the data source owns ordering.
 * @param {VirtualFs} fs
 * @returns {{files: Array<{path: string, sizeBytes?: number}>, count: number}}
 */
export function list(fs) {
  return { files: fs.files, count: fs.files.length };
}

/**
 * Match fs entries: wildcards (* ? **, case-insensitive) or fuzzy bare queries.
 * @param {VirtualFs} fs
 * @param {object} opts
 * @param {string[]} opts.patterns
 * @returns {{matches: Array<{path: string, sizeBytes?: number}>, count: number}}
 */
export function glob(fs, { patterns }) {
  const seen = new Set();
  const matches = [];
  for (const pattern of patterns) {
    for (const path of matchPattern(fs.files, pattern)) {
      if (!seen.has(path)) {
        seen.add(path);
        matches.push(path);
      }
    }
  }
  return { matches, count: matches.length };
}

/** Line numbers, truncation, and a continue-trailer. */
function formatRead(content, filePath, offset, limit) {
  const lines = content.split('\n');
  const totalLines = lines.length;
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw error('bad_path', `Offset ${offset} is out of range for ${filePath} (${totalLines} lines)`);
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
    body += `\n\n(Output capped at ${Math.floor(MAX_BYTES / 1024)} KB. Showing lines ${offset}-${endLine}. Continue with offset ${endLine + 1}.)`;
  } else if (hasMoreLines) {
    body += `\n\n(Showing lines ${offset}-${endLine} of ${totalLines}. Continue with offset ${endLine + 1}.)`;
  } else {
    body += `\n\n(End of file - total ${totalLines} lines)`;
  }

  return { startLine: offset, endLine, totalLines, sizeBytes: bytes, truncated, body };
}

/** Regex-scan fetched contents; caller compiles flags; caps at MAX_GREP_RESULTS. */
function scanMatches(fileMap, regex) {
  const matches = [];
  let truncated = false;
  outer: for (const [filePath, content] of Object.entries(fileMap)) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_RESULTS) {
        truncated = true;
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
  return { matches, truncated };
}

/** Include matched nothing -> say where paths live, not "no content matched". */
function buildIncludeHint(entries, patterns, packageName) {
  const topLevelDirs = [
    ...new Set(
      entries
        .map((f) => f.path.split('/').slice(0, -1).join('/'))
        .filter(Boolean)
        .map((dir) => dir.split('/').slice(0, 3).join('/')),
    ),
  ].slice(0, 10);
  return `include "${patterns.join(', ')}" matched no files in ${packageName}. Package paths carry full directory prefixes (e.g. ${topLevelDirs.join(', ')}). Run glob first to locate files, or drop include to search the whole package.`;
}

/** Bounded-concurrency mapper; per-item failures resolve to undefined. */
async function runBatched(items, concurrency, worker) {
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

/**
 * Read one file from the fs (cat semantics): binary refusal, tree-based
 * not_found, then cached load.
 * @param {VirtualFs} fs
 * @param {object} opts
 * @param {string} opts.path - file path within the package (leading "/" optional)
 * @param {number} [opts.offset=1] - 1-indexed start line
 * @param {number} [opts.limit=2000] - max lines returned
 * @returns {Promise<{path: string, startLine: number, endLine: number, totalLines: number, sizeBytes: number, truncated: boolean, content: string}>}
 */
export async function read(fs, { path, offset = 1, limit = DEFAULT_READ_LIMIT }) {
  const key = normalizePath(path);
  if (isBinaryPath(key)) {
    throw error('binary_file', `Cannot read binary file: ${key}`);
  }
  const known = fs.contents.has(key) || fs.files.some((f) => f.path === key);
  if (!known) {
    throw error('not_found', `File not found in ${fs.name}: ${key}`);
  }
  const content = fs.contents.has(key) ? fs.contents.get(key) : await fs.load(key);
  return formatRead(content, path, offset, limit);
}

/**
 * Regex-scan the fs (grep semantics): include scoping (one or several glob
 * patterns), binary skip, deterministic file pagination via fileOffset,
 * bounded-concurrency loads, hint on empty include. truncated means "the
 * result is incomplete": hit lines were capped, or files remained unsearched.
 * @param {VirtualFs} fs
 * @param {object} opts
 * @param {RegExp} opts.regex - compiled pattern (the args contract compiles it)
 * @param {string|string[]} [opts.include] - glob pattern(s) scoping searched files
 * @param {number} [opts.maxFiles=30] - max files downloaded per call
 * @param {number} [opts.fileOffset=1] - 1-indexed candidate to start from (candidates keep a stable order)
 * @returns {Promise<{count: number, truncated: boolean, filesSearched: number, filesSkipped: number, matches: {file: string, line: number, text: string}[], hint?: string}>}
 */
export async function grep(fs, { regex, include, maxFiles = MAX_GREP_DOWNLOAD_FILES, fileOffset = 1 }) {
  const patterns = Array.isArray(include) ? include.filter(Boolean) : include ? [include] : null;
  let candidates = fs.files;
  let hint;
  if (patterns) {
    candidates = glob(fs, { patterns }).matches;
    if (candidates.length === 0) {
      // "No files matched" must never read as "no content matched".
      hint = buildIncludeHint(fs.files, patterns, fs.name);
      candidates = [];
    } else {
      candidates = candidates.filter((f) => !isBinaryPath(f.path));
    }
  } else {
    candidates = candidates.filter((f) => !isBinaryPath(f.path));
  }

  const start = fileOffset - 1;
  const toSearch = candidates.slice(start, start + maxFiles);
  const filesSkipped = Math.max(candidates.length - start - maxFiles, 0);

  const contents = await runBatched(toSearch, GREP_CONCURRENCY, (entry) => fs.load(entry.path));
  const fileMap = {};
  for (const [i, content] of contents.entries()) {
    if (content !== undefined) fileMap[toSearch[i].path] = content;
  }

  const { matches, truncated: hitsTruncated } = scanMatches(fileMap, regex);

  const result = {
    count: matches.length,
    truncated: hitsTruncated || filesSkipped > 0,
    filesSearched: Object.keys(fileMap).length,
    filesSkipped,
    matches,
  };
  if (hint) result.hint = hint;
  else if (filesSkipped > 0) {
    result.hint = `${filesSkipped} file(s) not searched (cap: ${maxFiles}). Continue with fileOffset ${fileOffset + maxFiles}, or narrow with include.`;
  }
  return result;
}
