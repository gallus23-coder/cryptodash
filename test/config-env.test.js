'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnvFile, getKrakenCredentials } = require('../src/config/env');

function tmpEnvFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptodash-env-'));
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, contents);
  return file;
}

test('loadEnvFile returns {} when the file does not exist', () => {
  assert.deepEqual(loadEnvFile('/nonexistent/path/env'), {});
});

test('loadEnvFile parses KEY=VALUE lines, skips blanks and comments', () => {
  const file = tmpEnvFile([
    '# comment',
    '',
    'KRAKEN_API_KEY=fake_key_abc',
    'KRAKEN_API_SECRET=ZmFrZV9zZWNyZXQ=',
    '  SPACED = trimmed  ',
  ].join('\n'));
  assert.deepEqual(loadEnvFile(file), {
    KRAKEN_API_KEY: 'fake_key_abc',
    KRAKEN_API_SECRET: 'ZmFrZV9zZWNyZXQ=',
    SPACED: 'trimmed',
  });
});

test('getKrakenCredentials reads KRAKEN_API_KEY/KRAKEN_API_SECRET from a given file', () => {
  const file = tmpEnvFile('KRAKEN_API_KEY=fake_key\nKRAKEN_API_SECRET=fake_secret\n');
  assert.deepEqual(getKrakenCredentials(file), { apiKey: 'fake_key', apiSecret: 'fake_secret' });
});

test('getKrakenCredentials returns undefineds when the file is missing', () => {
  const creds = getKrakenCredentials('/nonexistent/path/env');
  assert.equal(creds.apiKey, undefined);
  assert.equal(creds.apiSecret, undefined);
});
