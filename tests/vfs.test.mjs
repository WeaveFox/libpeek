import { test } from 'node:test';
import assert from 'node:assert/strict';

import { list, glob, read, grep, MAX_BYTES } from '../skills/libpeek/scripts/vfs.mjs';

/** Minimal in-memory virtual fs; contents are preloaded, load() never hits a data source. */
function fsOf({ files = [], contents = {}, name = 'test-pkg' } = {}) {
  const map = new Map(Object.entries(contents));
  return {
    name,
    files: files.map((f) => (typeof f === 'string' ? { path: f } : f)),
    contents: map,
    load: async (path) => {
      const key = path.startsWith('/') ? path : `/${path}`;
      if (map.has(key)) return map.get(key);
      throw new Error(`unexpected load: ${key}`);
    },
  };
}

// ─── list ────────────────────────────────────────────────────────────────────

test('list: returns fs entries with a count; ordering owned by the data source', () => {
  const fs = fsOf({ files: ['/b.js', { path: '/a.js', sizeBytes: 12 }] });
  assert.deepEqual(list(fs), { files: [{ path: '/b.js' }, { path: '/a.js', sizeBytes: 12 }], count: 2 });
});

// ─── glob ────────────────────────────────────────────────────────────────────

test('glob: ** crosses segments, * stays within one segment', () => {
  const fs = fsOf({ files: ['/dist/index.d.ts', '/dist/a/b.d.ts', '/src/index.ts'] });
  assert.deepEqual(glob(fs, { patterns: ['dist/**/*.d.ts'] }).matches, [
    { path: '/dist/index.d.ts' },
    { path: '/dist/a/b.d.ts' },
  ]);
  assert.deepEqual(glob(fs, { patterns: ['*.json'] }).matches, []);
  assert.deepEqual(glob(fs, { patterns: ['**'] }).matches, fs.files);
});

test('glob: "/"-less patterns match basenames at any depth, case-insensitively', () => {
  const fs = fsOf({ files: ['/package.json', '/dist/pack.json'] });
  assert.deepEqual(glob(fs, { patterns: ['*.json'] }).matches, [
    { path: '/package.json' },
    { path: '/dist/pack.json' },
  ]);
  const fs2 = fsOf({ files: ['/README.MD'] });
  assert.deepEqual(glob(fs2, { patterns: ['readme.md'] }).matches, [{ path: '/README.MD' }]);
});

test('glob: fuzzy compact boundary hits rank first', () => {
  const fs = fsOf({ files: ['/dist/esm/icons/arrow-up-left.mjs', '/dist/esm/icons/arrow-left.mjs'] });
  const ranked = glob(fs, { patterns: ['arrow-left'] }).matches;
  assert.equal(ranked[0].path, '/dist/esm/icons/arrow-left.mjs');
  assert.equal(ranked.length, 2);
});

test('glob: unions multiple patterns and dedupes', () => {
  const fs = fsOf({ files: ['/a.js', '/a.ts'] });
  assert.deepEqual(glob(fs, { patterns: ['*.js', '*.ts', 'a.js'] }).matches, [
    { path: '/a.js' },
    { path: '/a.ts' },
  ]);
});

test('glob: anchored literal paths match exactly or by prefix, never fuzzy', () => {
  const fs = fsOf({
    files: ['/dist/esm/icons/arrow-left.mjs', '/dist/esm/icons/arrow-left-circle.mjs'],
  });
  assert.deepEqual(glob(fs, { patterns: ['/dist/esm/icons/arrow-left.mjs'] }).matches, [
    { path: '/dist/esm/icons/arrow-left.mjs' },
  ]);
  assert.equal(glob(fs, { patterns: ['/dist/esm/icons/'] }).matches.length, 2); // prefix pulls the folder
});

test('glob: exact basename hit beats fuzzy for file-name-like queries', () => {
  const fs = fsOf({
    files: ['/x/faCircleDown.js', '/x/faCircleArrowDown.js', '/x/faCircleChevronDown.js'],
  });
  assert.deepEqual(glob(fs, { patterns: ['faCircleDown.js'] }).matches, [{ path: '/x/faCircleDown.js' }]);
});

// ─── read ────────────────────────────────────────────────────────────────────

test('read: small file ends with the total-lines trailer', async () => {
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': 'alpha\nbeta\ngamma' } });
  const r = await read(fs, { path: '/x.js' });
  assert.equal(r.startLine, 1);
  assert.equal(r.endLine, 3);
  assert.equal(r.totalLines, 3);
  assert.equal(r.truncated, false);
  assert.ok(r.body.includes('1: alpha'));
  assert.ok(r.body.endsWith('(End of file - total 3 lines)'));
});

test('read: line cap leaves a continue trailer', async () => {
  const content = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n');
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': content } });
  const r = await read(fs, { path: '/x.js', limit: 3 });
  assert.equal(r.truncated, true);
  assert.ok(r.body.includes('(Showing lines 1-3 of 10. Continue with offset 4.)'));
});

test('read: 50 KB cap wins and reports itself', async () => {
  const lines = Array.from({ length: 60 }, () => 'x'.repeat(1000)); // ~60 KB total
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': lines.join('\n') } });
  const r = await read(fs, { path: '/x.js' });
  assert.equal(r.truncated, true);
  assert.ok(r.sizeBytes <= MAX_BYTES);
  assert.ok(r.body.includes('(Output capped at 50 KB.'));
});

test('read: overlong lines are cut with the marker', async () => {
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': 'y'.repeat(2500) } });
  const r = await read(fs, { path: '/x.js' });
  assert.ok(r.body.includes('... (line truncated to 2000 chars)'));
});

test('read: offset beyond EOF throws bad_path', async () => {
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': 'a\nb' } });
  await assert.rejects(
    () => read(fs, { path: '/x.js', offset: 10 }),
    (err) => err.expected === true && err.code === 'bad_path',
  );
});

test('read: offset pagination resumes mid-file', async () => {
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': 'one\ntwo\nthree' } });
  const r = await read(fs, { path: '/x.js', offset: 2 });
  assert.equal(r.startLine, 2);
  assert.equal(r.endLine, 3);
  assert.ok(r.body.includes('2: two'));
});

test('read: binary paths are refused without any load', async () => {
  const fs = fsOf({ files: ['/logo.png'] });
  await assert.rejects(
    () => read(fs, { path: '/logo.png' }),
    (err) => err.expected === true && err.code === 'binary_file',
  );
});

test('read: paths absent from the tree are not_found before any load', async () => {
  const fs = fsOf({ files: ['/a.js'] });
  await assert.rejects(
    () => read(fs, { path: '/missing.js' }),
    (err) => err.expected === true && err.code === 'not_found',
  );
});

test('read: leading slash is optional', async () => {
  const fs = fsOf({ files: ['/x.js'], contents: { '/x.js': 'hello' } });
  const r = await read(fs, { path: 'x.js' });
  assert.ok(r.body.includes('1: hello'));
});

// ─── grep ────────────────────────────────────────────────────────────────────

test('grep: regex over multiple lines, honors compiled flags', async () => {
  const fs = fsOf({ files: ['/a.js'], contents: { '/a.js': 'word wordy\nWord\n' } });
  const r = await grep(fs, { regex: /\bword\b/gi });
  assert.equal(r.count, 2);
  assert.equal(r.matches[0].file, '/a.js');
  assert.equal(r.matches[0].line, 1);
  assert.equal(r.matches[1].line, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.hint, undefined);
});

test('grep: caps at 50 results and flags truncation', async () => {
  const content = Array.from({ length: 60 }, (_, i) => `hit-${i}`).join('\n');
  const fs = fsOf({ files: ['/a.js'], contents: { '/a.js': content } });
  const r = await grep(fs, { regex: /hit-\d+/gi });
  assert.equal(r.count, 50);
  assert.equal(r.truncated, true);
});

test('grep: overlong match lines are clipped with an ellipsis', async () => {
  const fs = fsOf({ files: ['/a.js'], contents: { '/a.js': 'z'.repeat(2500) } });
  const r = await grep(fs, { regex: /z/g });
  assert.ok(r.matches[0].text.length <= 2003);
  assert.ok(r.matches[0].text.includes('...'));
});

test('grep: include matched nothing -> hint, not empty success', async () => {
  const fs = fsOf({ files: ['/dist/a.js', '/src/lib/c.js'] });
  const r = await grep(fs, { regex: /x/g, include: 'xyz' });
  assert.equal(r.count, 0);
  assert.ok(r.hint.includes('/dist'));
  assert.ok(r.hint.includes('/src/lib'));
  assert.ok(r.hint.includes('glob'));
});

test('grep: binary files are skipped within include matches', async () => {
  const fs = fsOf({
    files: ['/x/a.png', '/x/a.js'],
    contents: { '/x/a.js': 'needle' },
  });
  const r = await grep(fs, { regex: /needle/gi, include: '/x/*' });
  assert.equal(r.filesSearched, 1);
  assert.equal(r.count, 1);
});

test('grep: files beyond the maxFiles cap are skipped with a hint', async () => {
  const fs = fsOf({
    files: ['/a.js', '/b.js', '/c.js', '/d.js', '/e.js'],
    contents: { '/a.js': 'hit', '/b.js': 'hit' },
  });
  const r = await grep(fs, { regex: /hit/gi, maxFiles: 2 });
  assert.equal(r.filesSearched, 2);
  assert.equal(r.filesSkipped, 3);
  assert.equal(r.truncated, true); // incomplete: files remained unsearched
  assert.ok(r.hint.includes('not searched'));
});

test('grep: fileOffset paginates candidates deterministically (1-indexed)', async () => {
  const paths = ['/a.js', '/b.js', '/c.js', '/d.js', '/e.js'];
  const contents = Object.fromEntries(paths.map((p) => [p, 'hit']));
  const fs = fsOf({ files: paths, contents });
  const first = await grep(fs, { regex: /hit/gi, maxFiles: 2 });
  assert.deepEqual(first.matches.map((m) => m.file), ['/a.js', '/b.js']);
  assert.equal(first.filesSkipped, 3);
  assert.equal(first.truncated, true);
  assert.ok(first.hint.includes('fileOffset 3'));
  const second = await grep(fs, { regex: /hit/gi, maxFiles: 2, fileOffset: 3 });
  assert.deepEqual(second.matches.map((m) => m.file), ['/c.js', '/d.js']);
  assert.equal(second.filesSkipped, 1);
  assert.ok(second.hint.includes('fileOffset 5'));
  const last = await grep(fs, { regex: /hit/gi, maxFiles: 2, fileOffset: 5 });
  assert.deepEqual(last.matches.map((m) => m.file), ['/e.js']);
  assert.equal(last.filesSkipped, 0);
  assert.equal(last.truncated, false);
  assert.equal(last.hint, undefined);
});

test('grep: include accepts several glob patterns', async () => {
  const fs = fsOf({
    files: ['/a.js', '/b.ts', '/c.md'],
    contents: { '/a.js': 'hit', '/c.md': 'hit' },
  });
  const r = await grep(fs, { regex: /hit/gi, include: ['*.js', '*.md'] });
  assert.deepEqual(r.matches.map((m) => m.file), ['/a.js', '/c.md']);
  assert.equal(r.filesSearched, 2);
  assert.equal(r.truncated, false);
});

test('grep: empty multi-pattern include hint lists every pattern', async () => {
  const fs = fsOf({ files: ['/dist/a.js', '/src/lib/c.js'] });
  const r = await grep(fs, { regex: /x/g, include: ['nope1', 'nope2'] });
  assert.equal(r.count, 0);
  assert.ok(r.hint.includes('nope1, nope2'));
  assert.ok(r.hint.includes('/dist'));
});

test('grep: single load failure does not kill the batch', async () => {
  const fs = fsOf({ files: ['/ok.js', '/boom.js'], contents: { '/ok.js': 'hit here' } });
  const r = await grep(fs, { regex: /hit/gi });
  // /boom.js is in the tree but not cached; the fixture load throws -> skipped
  assert.equal(r.filesSearched, 1);
  assert.equal(r.count, 1);
});
