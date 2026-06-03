'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('fetchFearGreed returns parsed value and classification', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ value: '42', value_classification: 'Fear' }] }),
  });
  try {
    // require after mock is set (module has no top-level fetch call)
    const { fetchFearGreed } = require('../feargreed');
    const result = await fetchFearGreed();
    assert.equal(result.value, 42);
    assert.equal(result.classification, 'Fear');
  } finally {
    global.fetch = saved;
  }
});

test('fetchFearGreed throws on non-ok response', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429 });
  try {
    const { fetchFearGreed } = require('../feargreed');
    await assert.rejects(() => fetchFearGreed(), /429/);
  } finally {
    global.fetch = saved;
  }
});

test('fetchFearGreed value is an integer', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ value: '75', value_classification: 'Extreme Greed' }] }),
  });
  try {
    const { fetchFearGreed } = require('../feargreed');
    const result = await fetchFearGreed();
    assert.strictEqual(typeof result.value, 'number');
    assert.equal(result.value, 75);
    assert.equal(result.classification, 'Extreme Greed');
  } finally {
    global.fetch = saved;
  }
});
