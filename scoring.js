// scoring.js — pure scoring function: inputs -> AI call -> validated result.
//
// No auth, no DynamoDB, no API Gateway, no AWS SDK. Takes resumeText,
// jobDescriptionText, and an API key as plain arguments and returns the
// scored result. This is what lets the Lambda handler AND the Phase 5 eval
// harness call the exact same code path: the handler passes the Secrets
// Manager value as `apiKey`; the eval passes a value from a local gitignored
// .env. Same function, two callers, the key itself is never hardcoded or
// read from an env var inside this file.

const { computeKeywordCoverage } = require('./keywordCoverage.js');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const JD_CHAR_LIMIT = 6000;
const RESUME_CHAR_LIMIT = 4000;
const MAX_BULLETS = 3;             // strengths / gaps
const MAX_BULLET_WORDS = 12;       // per strengths/gaps item -- prompt aims for 8-12, this is the hard upper cap
const MAX_REASON_CHARS = 90;       // legitimacyReason -- CHARACTER budget (chars track the narrow ~198px Posting-Analysis column's pixel width far better than words did). Set just inside the 3-line CSS clamp (popup.css #legitimacyReasonText) so the server-side word-boundary cut wins over the browser's mid-word "…". Prompt aims well under this (~8-10 words).
const MAX_SUMMARY_WORDS = 55;      // summary -- backstop, tuned to fit popup.css's 6-line clamp on .summary-text
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const LEGITIMACY_FLAGS = ['clean', 'suspicious', 'unclear'];
const CODE_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

// Claude is told "no markdown, no backticks" in the prompt but sometimes
// wraps its JSON in a code fence anyway -- a known, common LLM quirk, not a
// sign the underlying JSON is malformed. Stripped defensively so the live
// product doesn't fail on a purely cosmetic formatting slip; the shape
// validation right after this still catches genuinely malformed output.
// (Trade-off, noted for Phase 5: this makes the schema grader's "wraps in
// backticks" dimension pass here too, since it reuses this same parse step
// -- the raw compliance rate is no longer visible from that grader alone.)
function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(CODE_FENCE);
  return match ? match[1] : trimmed;
}

// Enforced in code, not just requested in the prompt -- same reasoning as
// computeKeywordCoverage replacing the fabricated atsScore: the product's
// layout can't depend on the model being in a terse mood. Word-based (not
// character-based) so a cut never lands mid-word; appends an ellipsis only
// when it actually truncated something.
function truncateWords(text, maxWords) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '…';
}

// Same backstop as truncateWords, but for summary -- which reads worse cut
// off mid-sentence with a trailing "…" than it does slightly short. Keeps
// only whole sentences that fit under maxWords; a dropped trailing sentence
// is silently omitted rather than mangled. Splits on ./!/? followed by
// whitespace or end-of-string (a plain heuristic -- doesn't special-case
// abbreviations like "e.g.", not worth the complexity for this text).
// Falls back to truncateWords only if even the first sentence alone
// exceeds the budget, so this can never return an empty string.
function truncateSentences(text, maxWords) {
  const trimmed = text.trim();
  const sentences = trimmed.match(/[^.!?]+[.!?]+(\s+|$)/g) || [trimmed];
  let result = '';
  let wordCount = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.trim().split(/\s+/).length;
    if (wordCount + sentenceWords > maxWords) {
      if (!result) return truncateWords(trimmed, maxWords); // first sentence alone is too long
      break;
    }
    result += sentence;
    wordCount += sentenceWords;
  }
  return result.trim() || truncateWords(trimmed, maxWords);
}

// Character-budget backstop for legitimacyReason. Char count tracks the
// rendered pixel width of the narrow (~198px) Posting Analysis column far
// better than word count did -- word-based budgets kept overflowing the
// 3-line CSS clamp (popup.css #legitimacyReasonText), which made the browser
// insert a mid-word "…". Cuts on a whole-word boundary, strips a dangling
// comma/dash/semicolon so we never get "realistic,…", and only appends "…"
// when it actually dropped text. With maxChars set just inside the column's
// ~3-line capacity, THIS cut wins over the CSS clamp -- the CSS "…" becomes
// an unreachable last resort. The prompt already asks for one short clause,
// so in practice this rarely fires at all.
function truncateChars(text, maxChars) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const clipped = trimmed.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return cut.replace(/[\s,;:–—-]+$/, '') + '…';
}

function buildPrompt(jobDescriptionText, resumeText, postedDaysAgo = null) {
  // Hybrid freshness: when the client passed a deterministic posting age, let
  // the model MENTION it in the summary's closing sentence -- it never owns the
  // fresh/stale/closed verdict (that stays the client-side chip, utils/parser.js
  // detectFreshness()). Empty string when no age was given, so the prompt for
  // every shared-key / no-freshness request stays byte-identical to before,
  // keeping the Phase 5 baseline unperturbed.
  const ageGuidance = typeof postedDaysAgo === 'number'
    ? `\nThis job posting is ${postedDaysAgo} days old. If that is more than about a month, you MAY note in the closing sentence of "summary" that it may already be filled; if it is recent, do not mention its age at all. Never state an age you were not given.\n`
    : '';
  return `You are an expert technical recruiter and resume coach.

Analyze the job posting and candidate resume below. Return two assessments:
1. How well the resume matches the job
2. An analysis of the job posting itself for quality and legitimacy

<job_posting>
${jobDescriptionText}
</job_posting>

<candidate_resume>
${resumeText}
</candidate_resume>

Keep "strengths" and "gaps" to at most 3 items EACH — only the most important
ones, no filler. Keep every item in "strengths" and "gaps" to about 8-12
words, short enough to fit on one line.

"legitimacyReason" MUST be exactly ONE short, simple sentence that ends with a
period — about 8-10 words and no more than 90 characters total. Use a single
plain clause: NO semicolons, NO dashes, NO lists. If you are tempted to add a
second clause, cut it instead of chaining them together. Prefer plain, short
words over long ones so it stays compact and fits fully in a small space.

Also write a "summary": exactly 3 sentences, under about 50 words total,
written to help the candidate decide whether this job is worth applying to —
inform the decision, don't make it for them. Sentence 1: the overall fit,
grounded in the score and what's actually driving it. Sentence 2: the single
most decision-relevant strength or gap — whichever matters more, not a
generic recap. Sentence 3: a short, decision-framed close phrased as a
condition ("worth applying if...", "a stretch given...", "a strong fit
unless..."), not an instruction telling them what to do.
${ageGuidance}
Also extract "keySkills": the concrete, named technical skills the JOB POSTING
asks for — pull these from the posting ONLY, never from the resume. Include what
the posting lists in BOTH its required and preferred sections: programming
languages, frameworks, libraries, tools, platforms, databases, and named
technologies. Rules for keySkills:
- One atomic token per skill. Never join skills with a slash or "and" — write
  "JavaScript" and "React" as two separate items, never "JavaScript/React".
- For an "A or B or C" option list (e.g. "AWS, Azure, or GCP"; "relational or
  NoSQL"), emit ONE broad category token instead of every option — e.g. "Cloud",
  "Database".
- BUT if the posting names a specific technology directly (e.g. "SQL"), keep it
  as its own token even when a related category token also applies — never fold
  a specifically-named skill into a broader category. A posting that names "SQL"
  and separately mentions "relational or NoSQL databases" yields BOTH "SQL" and
  "Database".
- Use the plain term the posting uses so it can be matched literally, but write
  each token with normal display capitalization (e.g. "Cloud", not "cloud").
  Matching is case-insensitive, so casing only affects how the chip reads.
- EXCLUDE soft or conceptual skills that are not literal keywords — e.g. Agile,
  data structures, algorithms, debugging, problem-solving, communication,
  teamwork. Those belong in "strengths"/"gaps", not here.

Return ONLY a valid JSON object. No explanation, no markdown, no backticks. Schema:
{
  "score": number 0-100,
  "strengths": string[],          // at most 3, ~8-12 words or fewer each
  "gaps": string[],               // at most 3, ~8-12 words or fewer each
  "summary": string,              // exactly 3 sentences, see guidance above
  "keySkills": string[],          // concrete named tech from the POSTING only (required + preferred); atomic tokens; one category token for "A or B" lists; NO soft/conceptual skills
  "postingAnalysis": {
    "legitimacyFlag": "clean" | "suspicious" | "unclear",
    "legitimacyReason": string    // ONE short plain sentence ending in a period, no semicolons/dashes/lists, ~8-10 words, <=90 chars
  }
}`;
}

// Shared shape-check — imported by the Lambda handler AND the Phase 5 schema
// grader, so both check the identical thing. Never includes the raw response
// text in a thrown error (it may contain resume/posting content) — only
// field names, matching the project's no-PII-in-logs rule.
function validateScoringResponse(parsed) {
  if (
    typeof parsed.score !== 'number' ||
    !Number.isFinite(parsed.score) ||
    parsed.score < 0 ||
    parsed.score > 100
  ) {
    throw new Error('Invalid response shape: score');
  }

  for (const field of ['strengths', 'gaps', 'keySkills']) {
    if (!Array.isArray(parsed[field])) {
      throw new Error(`Invalid response shape: ${field}`);
    }
  }

  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    throw new Error('Invalid response shape: summary');
  }

  if (!parsed.postingAnalysis || typeof parsed.postingAnalysis !== 'object') {
    throw new Error('Invalid response shape: postingAnalysis');
  }
  if (!LEGITIMACY_FLAGS.includes(parsed.postingAnalysis.legitimacyFlag)) {
    throw new Error('Invalid response shape: postingAnalysis.legitimacyFlag');
  }
  if (
    typeof parsed.postingAnalysis.legitimacyReason !== 'string' ||
    !parsed.postingAnalysis.legitimacyReason.trim()
  ) {
    throw new Error('Invalid response shape: postingAnalysis.legitimacyReason');
  }
}

async function scoreResumeAgainstJob(resumeText, jobDescriptionText, apiKey, { fetchImpl = fetch, postedDaysAgo = null } = {}) {
  const resumeTruncated = resumeText.length > RESUME_CHAR_LIMIT;
  const truncatedResume = resumeText.slice(0, RESUME_CHAR_LIMIT);
  const truncatedJd = jobDescriptionText.slice(0, JD_CHAR_LIMIT);

  const prompt = buildPrompt(truncatedJd, truncatedResume, postedDaysAgo);

  const res = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Pinned to 0 so the free-form keySkills extraction step -- the one
      // part of "deterministic keyword coverage" that's still an LLM call --
      // samples as consistently as possible run-to-run on identical input.
      // computeKeywordCoverage() below was always deterministic; the
      // variance lived entirely upstream, in Claude's default (much higher)
      // sampling temperature. This narrows it a lot but isn't a hard
      // guarantee of bit-identical output every time -- stated honestly,
      // not oversold, same spirit as the rest of this module's comments.
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    // Attach the upstream status so the Lambda handler can distinguish an
    // auth rejection (401/403 -- a bad API key) from any other failure. Only
    // meaningful for BYOK: index.js checks this ONLY when the request supplied
    // the user's own key; a shared-key 401/403 is our infra problem, not
    // theirs. scoring.js itself stays BYOK-unaware -- it just reports what
    // Anthropic said; the BYOK-vs-shared decision lives entirely in index.js.
    const err = new Error(`Anthropic API error: ${res.status}`);
    err.anthropicStatus = res.status;
    throw err;
  }

  const data = await res.json();
  const rawText = data.content?.[0]?.text ?? '';

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    throw new Error('Failed to parse AI response as JSON');
  }

  validateScoringResponse(parsed);

  const keywordCoverage = computeKeywordCoverage(parsed.keySkills, truncatedResume);

  // Hard caps enforced in code, not just requested in the prompt -- an LLM
  // ignoring a length instruction is a prompt-compliance question the Phase
  // 5 eval should measure, not something the live product's layout should
  // have to absorb (the popup's result panel is a fixed height). Both count
  // (.slice) and per-item length (truncateWords) are enforced here.
  return {
    score: parsed.score,
    strengths: parsed.strengths.slice(0, MAX_BULLETS).map((s) => truncateWords(s, MAX_BULLET_WORDS)),
    gaps: parsed.gaps.slice(0, MAX_BULLETS).map((s) => truncateWords(s, MAX_BULLET_WORDS)),
    summary: truncateSentences(parsed.summary, MAX_SUMMARY_WORDS),
    keywordCoverage,
    postingAnalysis: {
      legitimacyFlag: parsed.postingAnalysis.legitimacyFlag,
      // truncateChars (char budget, cuts on a word boundary) -- see
      // MAX_REASON_CHARS. The reason is a single sentence, so there is no
      // trailing sentence to drop; a char cap set to beat the CSS clamp is
      // what actually prevents the mid-word "…" the word budget kept producing.
      legitimacyReason: truncateChars(parsed.postingAnalysis.legitimacyReason, MAX_REASON_CHARS),
    },
    resumeTruncated,
  };
}

module.exports = { scoreResumeAgainstJob, validateScoringResponse };
