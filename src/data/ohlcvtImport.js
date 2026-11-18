'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-o', zipPath, '-d', destDir]);
}

function extractSpecificFiles(zipPath, filenames, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-o', zipPath, ...filenames, '-d', destDir]);
}

function walkCsvFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCsvFiles(full));
    else if (entry.name.toLowerCase().endsWith('.csv')) out.push(full);
  }
  return out;
}

function findCsvFile(destDir, altname, intervalMinutes) {
  const wanted = `${altname}_${intervalMinutes}.csv`.toLowerCase();
  const candidates = walkCsvFiles(destDir);
  const match = candidates.find((f) => path.basename(f).toLowerCase() === wanted);
  if (!match) {
    const found = candidates.map((f) => path.basename(f)).join(', ') || '(no .csv files found at all)';
    throw new Error(`No file named ${altname}_${intervalMinutes}.csv under ${destDir}. Found: ${found}`);
  }
  return match;
}

module.exports = { extractZip, findCsvFile, extractSpecificFiles };
