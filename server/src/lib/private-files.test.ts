import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPrivate, writePrivate } from './private-files.js';

test('profile reads refuse symlinks and atomic writes replace them without changing the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-profile-'));
  try {
    const target = path.join(dir, 'owner-secret');
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(target, 'private');
    fs.symlinkSync(target, file);
    assert.throws(() => readPrivate(file));
    writePrivate(file, 'own config');
    assert.equal(fs.readFileSync(target, 'utf8'), 'private');
    assert.equal(readPrivate(file), 'own config');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
