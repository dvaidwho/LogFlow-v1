// run-eval.js — the scoring eval runner.
//
// Loads the local .env key, imports scoreResumeAgainstJob DIRECTLY (no API
// Gateway, no DynamoDB, no rate limit — an eval must not burn the daily cap or
// pay per-request overhead), runs every dev + test case, grades with
// graders.js, and prints a per-case table + separate DEV and held-out TEST
// pass rates. A case passes only if every one of its graded dimensions passes.
//
// Usage:
//   node evals/scoring/run-eval.js         # dev + test
//   node evals/scoring/run-eval.js dev      # one split only
//   node evals/scoring/run-eval.js test

const fs = require('fs');
const path = require('path');
const { scoreResumeAgainstJob } = require('../../scoring.js');
const { gradeCase } = require('./graders.js');

const DIR = __dirname;
const FIX = path.join(DIR, 'fixtures');

function loadEnvKey() {
  const env = fs.readFileSync(path.join(DIR, '../../.env'), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const key = line?.split('=').slice(1).join('=').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY not found in .env');
  return key;
}

function loadCases(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const readFixture = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };

async function runCase(c, key) {
  const resume = readFixture(c.resume);
  const jd = readFixture(c.jd);
  try {
    return { result: await scoreResumeAgainstJob(resume, jd, key), error: null };
  } catch (e) {
    return { result: null, error: e.message };
  }
}

async function runSplit(cases, key) {
  const out = [];
  for (const c of cases) {
    process.stdout.write(`  scoring ${pad(c.id, 32)}\r`);
    const { result, error } = await runCase(c, key);
    const rows = gradeCase(result, c.expect);
    out.push({ c, rows, casePass: rows.every((r) => r.pass), error });
  }
  process.stdout.write(' '.repeat(48) + '\r');
  return out;
}

function printRows(caseResults, split) {
  for (const { rows, c } of caseResults) {
    for (const r of rows) {
      const mark = r.pass ? '✓' : '✗';
      const note = r.note ? `  ← ${r.note}` : (r.pass ? '' : `  ← got ${r.actual}`);
      console.log(`${pad(c.id, 30)} ${pad(r.dimension, 16)} ${pad(r.expected, 24)} ${pad(r.actual, 18)} ${mark}  ${pad(split, 4)}${note}`);
    }
  }
}

(async () => {
  const key = loadEnvKey();
  const only = process.argv[2];
  const splits = [];
  if (!only || only === 'dev') splits.push(['dev', loadCases('dev.jsonl')]);
  if (!only || only === 'test') splits.push(['test', loadCases('test.jsonl')]);

  console.log(`\n${pad('CASE', 30)} ${pad('DIMENSION', 16)} ${pad('EXPECTED', 24)} ${pad('ACTUAL', 18)} P  SPLIT`);
  console.log('─'.repeat(104));

  const summary = {};
  for (const [split, cases] of splits) {
    const caseResults = await runSplit(cases, key);
    printRows(caseResults, split);
    summary[split] = {
      passed: caseResults.filter((x) => x.casePass).length,
      total: caseResults.length,
    };
  }

  console.log('─'.repeat(104));
  for (const [split, { passed, total }] of Object.entries(summary)) {
    const label = split === 'test' ? 'TEST PASS RATE (held-out)' : 'DEV PASS RATE           ';
    console.log(`${label}: ${passed}/${total}   (n=${total}, directional — small sample, wide error bars)`);
  }
  console.log('');
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
