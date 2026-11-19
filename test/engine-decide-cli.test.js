'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCliArgs, stripMarkdownFences, buildCliEnv } = require('../src/engine/decide');

function sampleConfig() {
  return { claudeModel: 'claude-sonnet-5', claudeEffort: 'low', claudeTimeoutMs: 30000 };
}

test('buildCliArgs puts the system prompt in --system-prompt and the user prompt as the final positional arg', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, sampleConfig());
  assert.ok(args.includes('--system-prompt'));
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
  assert.equal(args[args.length - 1], 'USER');
});

test('buildCliArgs always disables tool use with an empty --allowedTools', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, sampleConfig());
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], '');
});

test('buildCliArgs passes the configured model and effort through', () => {
  const args = buildCliArgs({ system: 'SYS', user: 'USER' }, { claudeModel: 'claude-haiku-4-5-20251001', claudeEffort: 'medium', claudeTimeoutMs: 1000 });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
});

test('stripMarkdownFences removes a ```json fence wrapping the response', () => {
  assert.equal(stripMarkdownFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('stripMarkdownFences removes a plain ``` fence (no language tag)', () => {
  assert.equal(stripMarkdownFences('```\n{"a":1}\n```'), '{"a":1}');
});

test('stripMarkdownFences passes unfenced text through unchanged (aside from trimming)', () => {
  assert.equal(stripMarkdownFences('  {"a":1}  '), '{"a":1}');
});

test('buildCliEnv excludes Kraken and Anthropic secrets from the subprocess environment', () => {
  const env = buildCliEnv({
    PATH: '/usr/bin', HOME: '/home/gallus23',
    KRAKEN_API_KEY: 'secret-key', KRAKEN_API_SECRET: 'secret-sig',
    ANTHROPIC_API_KEY: 'sk-ant-secret', TELEGRAM_BOT_TOKEN: 'secret-token',
  });
  assert.equal(env.KRAKEN_API_KEY, undefined);
  assert.equal(env.KRAKEN_API_SECRET, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
});

test('buildCliEnv keeps the allowlisted vars the CLI needs for OAuth and basic operation', () => {
  const env = buildCliEnv({ PATH: '/usr/bin', HOME: '/home/gallus23', LANG: 'en_US.UTF-8', SOME_RANDOM_VAR: 'x' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/gallus23');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.SOME_RANDOM_VAR, undefined);
});
