'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { extractZip, findCsvFile } = require('../src/data/ohlcvtImport');

function makeFixtureZip() {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-src-'));
  fs.writeFileSync(path.join(srcDir, 'XBTGBP_60.csv'), '1700000000,1,2,3,4,5,6\n');
  fs.writeFileSync(path.join(srcDir, 'ETHGBP_60.csv'), '1700000000,1,2,3,4,5,6\n');
  fs.writeFileSync(path.join(srcDir, 'XBTGBP_1440.csv'), '1700000000,1,2,3,4,5,6\n');
  const zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-zip-')), 'fixture.zip');
  execFileSync('zip', ['-j', zipPath, ...fs.readdirSync(srcDir).map((f) => path.join(srcDir, f))]);
  return zipPath;
}

test('extractZip unzips into destDir', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));

  extractZip(zipPath, destDir);

  assert.ok(fs.existsSync(path.join(destDir, 'XBTGBP_60.csv')));
  assert.ok(fs.existsSync(path.join(destDir, 'ETHGBP_60.csv')));
});

test('findCsvFile locates the right interval file for a pair', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));
  extractZip(zipPath, destDir);

  const found = findCsvFile(destDir, 'XBTGBP', 60);

  assert.equal(path.basename(found), 'XBTGBP_60.csv');
});

test('findCsvFile throws a descriptive error when no match exists, listing what it did find', () => {
  const zipPath = makeFixtureZip();
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohlcvt-dest-'));
  extractZip(zipPath, destDir);

  assert.throws(
    () => findCsvFile(destDir, 'DOGEGBP', 60),
    (err) => err.message.includes('DOGEGBP_60.csv') && err.message.includes('XBTGBP_60.csv'),
  );
});
