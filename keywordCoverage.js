// keywordCoverage.js — pure, deterministic keyword-coverage matcher.
//
// Takes the list of skills the LLM extracted from a job posting (`keySkills`)
// and checks, with plain regex, which ones literally appear in the resume
// text. No AI call, no randomness — same inputs always produce the same
// output. This is what makes the number gradeable (Phase 5 eval) and
// unit-testable (Phase 7) in a way the old fabricated `atsScore` never could
// be.
//
// Imported by scoring.js (Lambda) and by the eval harness (Phase 5) — both
// need the identical deterministic result, so this has zero AWS/Lambda
// dependencies and lives as a standalone module.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeKeywordCoverage(keySkills, resumeText) {
  const hay = resumeText.toLowerCase();
  const matched = [];
  const missing = [];

  for (const raw of keySkills) {
    const skill = raw.toLowerCase().trim();
    if (!skill) continue;
    // Word-boundary-ish match so "java" doesn't match inside "javascript".
    // Deliberately not \b — that's an ASCII-word-character boundary and
    // breaks on skills like "C++" or "CI/CD", where the boundary character
    // itself isn't a word character. This treats "start/end of string or
    // any non-alphanumeric character" as a boundary instead.
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(skill)}([^a-z0-9]|$)`);
    (pattern.test(hay) ? matched : missing).push(raw);
  }

  const coveragePct = keySkills.length
    ? Math.round((matched.length / keySkills.length) * 100)
    : 0;

  return { matched, missing, coveragePct };
}

module.exports = { computeKeywordCoverage, escapeRegex };
