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

test('loadEnvFile strips surrounding single or double quotes from values', () => {
  const file = tmpEnvFile([
    'DOUBLE="quoted value"',
    "SINGLE='quoted value'",
    'BARE=plain value',
  ].join('\n'));
  assert.deepEqual(loadEnvFile(file), {
    DOUBLE: 'quoted value',
    SINGLE: 'quoted value',
    BARE: 'plain value',
  });
});

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('getKrakenCredentials prefers process.env over the file when both are set', () => {
  const file = tmpEnvFile('KRAKEN_API_KEY=file_key\nKRAKEN_API_SECRET=file_secret\n');
  withEnv({ KRAKEN_API_KEY: 'env_key', KRAKEN_API_SECRET: 'env_secret' }, () => {
    assert.deepEqual(getKrakenCredentials(file), { apiKey: 'env_key', apiSecret: 'env_secret' });
  });
});

test('getKrakenCredentials falls back to CRYPTODASH_ENV_FILE when no explicit path and no process.env creds', () => {
  const file = tmpEnvFile('KRAKEN_API_KEY=file_key\nKRAKEN_API_SECRET=file_secret\n');
  const savedKey = process.env.KRAKEN_API_KEY;
  const savedSecret = process.env.KRAKEN_API_SECRET;
  delete process.env.KRAKEN_API_KEY;
  delete process.env.KRAKEN_API_SECRET;
  try {
    withEnv({ CRYPTODASH_ENV_FILE: file }, () => {
      assert.deepEqual(getKrakenCredentials(), { apiKey: 'file_key', apiSecret: 'file_secret' });
    });
  } finally {
    if (savedKey === undefined) delete process.env.KRAKEN_API_KEY; else process.env.KRAKEN_API_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.KRAKEN_API_SECRET; else process.env.KRAKEN_API_SECRET = savedSecret;
  }
});
