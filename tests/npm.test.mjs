import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseVersion,
  compareVersions,
  maxSatisfying,
  parseXRange,
  splitPackageArg,
  resolveVersion,
  open,
} from '../skills/libpeek/scripts/npm.mjs';

// ─── version primitives ──────────────────────────────────────────────────────

test('parseVersion handles v-prefix, prerelease, and rejects garbage', () => {
  assert.deepEqual(parseVersion('1.2.3'), { raw: '1.2.3', major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.equal(parseVersion('v2.0.0').major, 2);
  assert.deepEqual(parseVersion('1.0.0-beta.1').prerelease, ['beta', '1']);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('not-a-range!!'), null);
});

test('compareVersions orders numerically then by prerelease rules', () => {
  assert.ok(compareVersions(parseVersion('1.2.3'), parseVersion('1.10.0')) < 0);
  assert.ok(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0')) < 0);
  assert.ok(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-alpha.1')) < 0);
  assert.ok(compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-beta')) < 0);
  // numeric identifiers compare numerically, not lexicographically
  assert.ok(compareVersions(parseVersion('1.0.0-2'), parseVersion('1.0.0-11')) < 0);
  assert.equal(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
});

// ─── range parsing ───────────────────────────────────────────────────────────

test('parseXRange detaches prerelease suffixes from full versions only', () => {
  assert.deepEqual(parseXRange('1.3.0-beta.1'), { major: 1, minor: 3, patch: 0, prerelease: ['beta', '1'] });
  assert.deepEqual(parseXRange('1.2.x'), { major: 1, minor: 2, patch: null, prerelease: [] });
  assert.deepEqual(parseXRange('*'), { major: null, minor: null, patch: null, prerelease: [] });
  // semver forbids a prerelease on a partial version
  assert.equal(parseXRange('1-beta.1'), null);
});

test('maxSatisfying: caret ranges including 0.x special cases', () => {
  assert.equal(maxSatisfying(['1.2.3', '1.3.0', '2.0.0'], '^1.2.0'), '1.3.0');
  assert.equal(maxSatisfying(['0.2.5', '0.3.0'], '^0.2.3'), '0.2.5');
  assert.equal(maxSatisfying(['0.0.3', '0.0.4'], '^0.0.3'), '0.0.3');
});

test('maxSatisfying: tilde and x-ranges', () => {
  assert.equal(maxSatisfying(['1.2.9', '1.3.0'], '~1.2.3'), '1.2.9');
  assert.equal(maxSatisfying(['1.2.9', '1.3.0'], '1.2.x'), '1.2.9');
  assert.equal(maxSatisfying(['2.5.0', '3.0.0'], '2'), '2.5.0');
  assert.equal(maxSatisfying(['2.5.0', '3.0.0'], '*'), '3.0.0');
});

test('maxSatisfying: || alternatives pick the highest satisfying version', () => {
  assert.equal(maxSatisfying(['3.25.76', '4.6.7'], '^3.25.0 || ^4.0.0'), '4.6.7');
});

test('maxSatisfying: hyphen ranges with partial upper bounds', () => {
  assert.equal(maxSatisfying(['1.5.0', '2.1.0'], '1.2.3 - 2'), '2.1.0');
  assert.equal(maxSatisfying(['1.5.0', '2.3.9'], '1.2.3 - 2.3'), '2.3.9');
  // "2.3" upper bound is exclusive (<2.4.0), so 2.4.0 itself is excluded
  assert.equal(maxSatisfying(['1.5.0', '2.4.0'], '1.2.3 - 2.3'), '1.5.0');
});

test('prerelease versions only satisfy ranges that mention a prerelease', () => {
  assert.equal(maxSatisfying(['1.3.0-beta.1'], '^1.2.0'), null);
  assert.equal(maxSatisfying(['1.3.0-beta.1', '1.2.9'], '^1.2.0'), '1.2.9');
  // prerelease comparators (>=1.3.0-beta.1) parse and gate correctly
  assert.equal(maxSatisfying(['1.3.0-beta.1', '1.3.0-beta.2'], '>=1.3.0-beta.1 <1.3.0'), '1.3.0-beta.2');
  assert.equal(maxSatisfying(['1.3.0-beta.1'], '1.3.0-beta.1'), '1.3.0-beta.1');
});

test('maxSatisfying: >= and < boundaries', () => {
  assert.equal(maxSatisfying(['2.29.9', '3.0.0'], '>=2.0.0 <3.0.0'), '2.29.9');
  assert.equal(maxSatisfying(['1.9.9', '2.0.0'], '>1.0.0 <2.0.0'), '1.9.9');
});

test('invalid ranges throw invalid_range', () => {
  assert.throws(
    () => maxSatisfying(['1.0.0'], 'not-a-range!!'),
    (err) => err.expected === true && err.code === 'invalid_range',
  );
  assert.throws(
    () => maxSatisfying(['1.0.0'], '1.2.3 - wrong'),
    (err) => err.expected === true && err.code === 'invalid_range',
  );
});

// ─── package argument parsing ────────────────────────────────────────────────

test('splitPackageArg handles scoped packages and inline specs', () => {
  assert.deepEqual(splitPackageArg('react'), { name: 'react', spec: undefined });
  assert.deepEqual(splitPackageArg('react@19.1.0'), { name: 'react', spec: '19.1.0' });
  assert.deepEqual(splitPackageArg('@scope/pkg'), { name: '@scope/pkg', spec: undefined });
  assert.deepEqual(splitPackageArg('@scope/pkg@^1.2.0'), { name: '@scope/pkg', spec: '^1.2.0' });
  assert.deepEqual(splitPackageArg('react@'), { name: 'react', spec: undefined });
});

// ─── data source with stubbed fetch (offline) ────────────────────────────────

const realFetch = globalThis.fetch;

/** Stub global fetch: respond(url) -> {status, body} (object body = JSON). */
function stubFetch(respond) {
  globalThis.fetch = async (url) => {
    const res = respond(String(url));
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.status >= 400 ? 'Error' : 'OK',
      text: () => (res.textThrows ? Promise.reject(new Error('body read boom')) : Promise.resolve(body)),
    };
  };
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'libpeek-cache-'));
});

afterEach(() => {
  rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

describe('resolveVersion (stubbed registry)', () => {
  const PACKUMENT = {
    'dist-tags': { latest: '3.11.0', next: '4.0.0-beta.1' },
    versions: { '3.0.0': {}, '3.11.0': {}, '4.0.0-beta.1': {} },
  };

  test('exact versions never hit the registry', async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return { status: 500 };
    });
    assert.equal(await resolveVersion('pkg-a', '1.2.3'), '1.2.3');
    assert.equal(calls, 0);
  });

  test('dist-tags resolve directly', async () => {
    stubFetch((url) => ({ status: 200, body: url.includes('pkg-b') ? PACKUMENT : {} }));
    assert.equal(await resolveVersion('pkg-b', 'latest'), '3.11.0');
    assert.equal(await resolveVersion('pkg-b', 'next'), '4.0.0-beta.1');
  });

  test('semver ranges resolve via maxSatisfying', async () => {
    stubFetch((url) => ({ status: 200, body: url.includes('pkg-c') ? PACKUMENT : {} }));
    assert.equal(await resolveVersion('pkg-c', '~3.0.0'), '3.0.0');
    assert.equal(await resolveVersion('pkg-c', '^3.0.0'), '3.11.0');
  });

  test('unmatched ranges throw no_version', async () => {
    stubFetch((url) => ({ status: 200, body: url.includes('pkg-d') ? PACKUMENT : {} }));
    await assert.rejects(
      () => resolveVersion('pkg-d', '^9.0.0'),
      (err) => err.expected === true && err.code === 'no_version',
    );
  });
});

describe('open.load (stubbed mirrors)', () => {
  const okText = 'file body';
  const TREE = { version: '1.0.0', files: [{ name: 'index.js', type: 'file', size: 123 }] };

  test('403 on the first mirror falls through to the next', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      if (url.includes('unpkg.com')) return { status: 403 };
      if (url.includes('cdn.jsdelivr.net')) return { status: 200, body: okText };
      return { status: 500 };
    });
    const fs = await open('pkg-e', '1.0.0');
    assert.equal(await fs.load('index.js'), okText);
  });

  test('all-404 becomes not_found', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 404 };
    });
    const fs = await open('pkg-f', '1.0.0');
    await assert.rejects(
      () => fs.load('missing.js'),
      (err) => err.expected === true && err.code === 'not_found',
    );
  });

  test('non-404 failures surface an http error with per-mirror attempts', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 500 };
    });
    const fs = await open('pkg-g', '1.0.0');
    await assert.rejects(
      () => fs.load('x.js'),
      (err) => err.expected === true && err.code === 'http' && err.message.includes('unpkg.com'),
    );
  });

  test('body-read failures surface as expected http errors, not internal', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 200, body: '', textThrows: true };
    });
    const fs = await open('pkg-j', '1.0.0');
    await assert.rejects(
      () => fs.load('index.js'),
      (err) => err.expected === true && err.code === 'http',
    );
  });
});

describe('open (stubbed jsDelivr tree)', () => {
  test('builds the flattened, sorted entry tree once', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        version: '1.0.0',
        files: [
          { name: 'package.json', type: 'file', size: 10 },
          {
            name: 'dist',
            type: 'directory',
            files: [
              { name: 'index.js', type: 'file', size: 20 },
              { name: 'index.d.ts', type: 'file', size: 30 },
            ],
          },
          { name: 'logo.png', type: 'file', size: 40 },
        ],
      },
    }));
    const fs = await open('pkg-h', '1.0.0');
    assert.deepEqual(fs.files, [
      { path: '/dist/index.d.ts', sizeBytes: 30 },
      { path: '/dist/index.js', sizeBytes: 20 },
      { path: '/logo.png', sizeBytes: 40 },
      { path: '/package.json', sizeBytes: 10 },
    ]);
  });

  test('caches contents across loads (same path, different slash form)', async () => {
    let fetches = 0;
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) {
        return { status: 200, body: { version: '1.0.0', files: [{ name: 'a.js', type: 'file' }] } };
      }
      fetches++;
      return { status: 200, body: 'body' };
    });
    const fs = await open('pkg-i', '1.0.0');
    assert.equal(await fs.load('/a.js'), 'body');
    assert.equal(await fs.load('a.js'), 'body'); // same path, normalized
    assert.equal(fetches, 1); // second load hit the contents cache
  });
});

describe('open disk cache (XDG_CACHE_HOME temp dir)', () => {
  const TREE = { version: '1.0.0', files: [{ name: 'index.js', type: 'file', size: 123 }] };

  test('tree and fetched contents are persisted after a networked open/load', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 200, body: 'fetched-body' };
    });
    const fs = await open('pkg-t', '1.0.0');
    assert.equal(await fs.load('/index.js'), 'fetched-body');
    const dir = join(process.env.XDG_CACHE_HOME, 'libpeek', 'pkg-t@1.0.0');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tree.json'), 'utf8')), [
      { path: '/index.js', sizeBytes: 123 },
    ]);
    assert.equal(readFileSync(join(dir, 'content', 'index.js'), 'utf8'), 'fetched-body');
  });

  test('a warm cache serves tree and contents with zero network calls', async () => {
    const dir = join(process.env.XDG_CACHE_HOME, 'libpeek', 'pkg-r@1.0.0');
    await mkdir(join(dir, 'content'), { recursive: true });
    await writeFile(join(dir, 'tree.json'), JSON.stringify([{ path: '/index.js', sizeBytes: 5 }]));
    await writeFile(join(dir, 'content', 'index.js'), 'cached-body');
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls++;
      return null; // any fetch attempt fails via unexpected-fetch
    });
    const fs = await open('pkg-r', '1.0.0');
    assert.deepEqual(fs.files, [{ path: '/index.js', sizeBytes: 5 }]);
    assert.equal(await fs.load('/index.js'), 'cached-body');
    assert.equal(fetchCalls, 0);
  });

  test('a v1 string[] tree cache upgrades in place to entries', async () => {
    const dir = join(process.env.XDG_CACHE_HOME, 'libpeek', 'pkg-v1@1.0.0');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tree.json'), '["/index.js"]');
    stubFetch(() => null); // any fetch attempt fails via unexpected-fetch
    const fs = await open('pkg-v1', '1.0.0');
    assert.deepEqual(fs.files, [{ path: '/index.js' }]);
  });

  test('a corrupt tree cache falls back to the network silently', async () => {
    const dir = join(process.env.XDG_CACHE_HOME, 'libpeek', 'pkg-c@1.0.0');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tree.json'), 'not json');
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 200, body: '' };
    });
    const fs = await open('pkg-c', '1.0.0');
    assert.deepEqual(fs.files, [{ path: '/index.js', sizeBytes: 123 }]);
  });

  test('unsafe names and ".." paths bypass the disk cache entirely', async () => {
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 200, body: 'served' };
    });
    const fs = await open('../evil-name', '1.0.0');
    assert.equal(await fs.load('/../evil'), 'served');
    const root = join(process.env.XDG_CACHE_HOME, 'libpeek');
    assert.throws(() => readdirSync(root)); // nothing was ever written
  });

  test('LRU eviction clears everything when the budget is zero', async () => {
    process.env.LIBPEEK_CACHE_MAX_MB = '0';
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) return { status: 200, body: TREE };
      return { status: 200, body: 'body' };
    });
    const fs = await open('pkg-z', '1.0.0');
    await fs.load('/index.js');
    const root = join(process.env.XDG_CACHE_HOME, 'libpeek');
    assert.deepEqual(readdirSync(root), []); // written, then evicted immediately
    delete process.env.LIBPEEK_CACHE_MAX_MB;
  });

  test('LRU eviction removes the least-recently-used package first', async () => {
    process.env.LIBPEEK_CACHE_MAX_MB = '0.00004'; // ~42 bytes
    const root = join(process.env.XDG_CACHE_HOME, 'libpeek');
    const tinyEntries = JSON.stringify([{ path: '/i' }]); // 15 bytes on disk
    const oldDir = join(root, 'pkg-old@1.0.0');
    const newDir = join(root, 'pkg-new@1.0.0');
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, 'tree.json'), tinyEntries);
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, 'tree.json'), tinyEntries);
    const ancient = new Date('2000-01-01T00:00:00Z');
    await utimes(oldDir, ancient, ancient);
    stubFetch((url) => {
      if (url.includes('data.jsdelivr.com')) {
        // no sizeBytes -> flattens to {path:"/i"}, same 15-byte tree.json
        return { status: 200, body: { version: '1.0.0', files: [{ name: 'i', type: 'file' }] } };
      }
      return { status: 200, body: '' };
    });
    await open('pkg-lru', '1.0.0'); // fresh name: not held in the opened-Map by earlier cases
    assert.deepEqual(readdirSync(root).sort(), ['pkg-lru@1.0.0', 'pkg-new@1.0.0']);
    delete process.env.LIBPEEK_CACHE_MAX_MB;
  });
});
