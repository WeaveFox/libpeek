import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'libpeek', 'scripts', 'index.mjs');
const run = (args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });

test('unknown tool prints a usage error JSON and exits 1', () => {
  const r = run(['bogus']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.error, true);
  assert.equal(out.code, 'usage');
  assert.ok(out.message.includes('Available: list, glob, read, grep'));
});

test('malformed JSON args produce a usage error', () => {
  const r = run(['grep', '{not json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout.trim()).code, 'usage');
});

test('read without path fails before any network access', () => {
  const r = run(['read', '{"package":"react"}']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.code, 'usage');
  assert.ok(out.message.includes('"path"'));
});

test('glob without patterns fails before any network access', () => {
  const r = run(['glob', 'react']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.code, 'usage');
  assert.ok(out.message.includes('patterns'));
});

test('invalid package names fail fast with bad_name', () => {
  const r = run(['list', 'bad name!!']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout.trim()).code, 'bad_name');
});
