const store = require('../db');
const { createJSON, models } = require('../llm/openai');
const { loadContextData, renderContext } = require('../llm/context');

// Learning loop. Feedback events (thumbs up/down, ratings, things logged via
// chat) increment a per-user counter; once it reaches THRESHOLD we reset it
// and rewrite ONLY the `learned` preference field in the background with the
// fast model. Every other field belongs to the user.
//
// REFLECTION_ENABLED=false disables counting and reflecting (used while
// running scripts/api-test.js so it doesn't spend LLM credits).

const THRESHOLD = 3;
const MAX_BULLETS = 15;
const MAX_LEARNED_CHARS = 2500;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    learned: { type: 'string', description: `Markdown bullet list, one "- " bullet per line, max ${MAX_BULLETS} bullets` },
    summary: { type: 'string', description: 'One short sentence on what changed in the learned notes' },
  },
  required: ['learned', 'summary'],
};

const INSTRUCTIONS = `
You maintain the "Learned from feedback" notes of APP_NAME, a small personal app. These notes are fed
into every future AI call, so they must be short, concrete and actionable.

Read the preferences and all feedback (thumbs up/down with notes, ratings), then rewrite the learned notes:
- Concise bullets, max ${MAX_BULLETS}, each one line starting with "- ".
- Only infer patterns actually supported by the data. A thumbs down WITH a note is a strong signal;
  one silent dismissal is not enough, several are.
- Prefer specific, actionable observations over vague praise.
- Keep existing bullets that are still supported; update or drop ones contradicted by newer feedback.
  Do not restate what is already written in the other preference fields.
- If there is not enough signal yet, return the existing notes unchanged (or empty if none).
`.trim();

const running = new Set(); // uids with a reflection in progress (per instance)

const reflectionEnabled = () => process.env.REFLECTION_ENABLED !== 'false';

/** Run one reflection pass for a user and store the new `learned` text. */
async function runReflection(uid) {
  const data = await loadContextData(uid);
  const result = await createJSON({
    model: models.fast(),
    instructions: INSTRUCTIONS,
    input: `${renderContext(data)}\n\n# Task\nRewrite the learned notes now.`,
    schemaName: 'learned_notes',
    schema: SCHEMA,
    maxOutputTokens: 4000,
    label: 'reflect',
  });
  // Enforce the format server-side: bullets only, capped.
  const bullets = String(result.learned || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('- ') ? l : `- ${l.replace(/^[-*•]\s*/, '')}`))
    .slice(0, MAX_BULLETS);
  const learned = bullets.join('\n').slice(0, MAX_LEARNED_CHARS);
  const { changedFields } = await store.updatePreferences(
    uid,
    { learned },
    { updatedBy: 'reflection', summary: String(result.summary || 'Updated learned notes').trim() }
  );
  console.log(`[reflect] ${uid}: learned ${changedFields.length ? 'updated' : 'unchanged'} (${bullets.length} bullets)`);
}

/**
 * Count `n` feedback events. Never throws and never blocks the request:
 * reflection runs in the background once the threshold is reached.
 * Fire-and-forget work is not guaranteed to finish if the instance shuts
 * down; that's acceptable here (the next batch of feedback triggers it again).
 * On Cloud Run, CPU is throttled after the response unless instance-based
 * billing is enabled, so prefer awaiting it there.
 */
async function recordFeedbackEvents(uid, n = 1) {
  if (!reflectionEnabled() || n <= 0) return;
  try {
    const count = await store.incrementFeedbackCounter(uid, n);
    if (count < THRESHOLD || running.has(uid)) return;
    if (!(await store.claimReflection(uid, THRESHOLD))) return;
    running.add(uid);
    setImmediate(() => {
      runReflection(uid)
        .catch((err) => console.error(`[reflect] failed: ${err.message}`))
        .finally(() => running.delete(uid));
    });
  } catch (err) {
    console.error(`[reflect] could not record feedback event: ${err.message}`);
  }
}

module.exports = { recordFeedbackEvents, runReflection, THRESHOLD };
