const OpenAI = require('openai');
const { redact } = require('../http');

// Thin wrapper around the OpenAI Responses API:
// - one retry on 5xx / timeouts / connection errors (SDK retries disabled so
//   the policy lives in one place and total latency stays bounded)
// - failures surface as LLMError (HTTP 502) with a message safe to show users
// - createJSON() for strict structured outputs
// - token usage logged per call (never the key)

const REQUEST_TIMEOUT_MS = 150_000;

class LLMError extends Error {
  constructor(message, cause) {
    super(message);
    this.status = 502;
    this.cause = cause;
  }
}

let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new LLMError('AI is not configured (OPENAI_API_KEY missing)');
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

// Model names come from env so they can change without a code edit.
const models = {
  main: () => process.env.OPENAI_MODEL || 'gpt-5.4', // generation, edits, chat agent
  fast: () => process.env.OPENAI_MODEL_FAST || 'gpt-5.4-mini', // reflection, classification
};

function isRetryable(err) {
  if (err instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  const status = err && err.status;
  return typeof status === 'number' && status >= 500;
}

function describe(err) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'the AI request timed out';
  if (err instanceof OpenAI.APIConnectionError) return 'could not reach the AI service';
  if (err && err.status === 429) return 'the AI service is rate limited or out of credits';
  if (err && (err.status === 401 || err.status === 403)) return 'the AI service rejected our credentials';
  if (err && typeof err.status === 'number') return `the AI service returned an error (${err.status})`;
  return redact(err && err.message) || 'unknown AI error';
}

/** responses.create with the retry policy. `label` is only used for logs. */
async function createResponse(params, { label = 'llm' } = {}) {
  const openai = getClient();
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await openai.responses.create(params);
      const usage = response.usage || {};
      console.log(
        `[llm] ${label} model=${params.model} ${Date.now() - started}ms in=${usage.input_tokens || '?'} out=${usage.output_tokens || '?'}`
      );
      return response;
    } catch (err) {
      if (attempt === 1 && isRetryable(err)) {
        console.warn(`[llm] ${label} attempt 1 failed (${describe(err)}); retrying once`);
        continue;
      }
      console.error(`[llm] ${label} failed: ${redact(err && err.message)}`);
      throw new LLMError(`AI request failed: ${describe(err)}. Please try again.`, err);
    }
  }
  throw new LLMError('AI request failed');
}

/**
 * Call the model with a strict JSON schema and return the parsed object.
 * Strict schemas: every property listed in `required`, optional values typed
 * as ['string', 'null'], and `additionalProperties: false` on every object.
 */
async function createJSON({ model, instructions, input, schemaName, schema, effort = 'low', maxOutputTokens = 16000, label }) {
  const response = await createResponse(
    {
      model: model || models.main(),
      instructions,
      input,
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
    },
    { label: label || schemaName }
  );
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details && response.incomplete_details.reason;
    throw new LLMError(`AI response was cut off (${reason || 'incomplete'}). Please try again.`);
  }
  const refusal = findRefusal(response);
  if (refusal) throw new LLMError(`AI declined: ${refusal}`);
  return parseJSON(response.output_text);
}

/** Plain text answer (e.g. "ask about this item"). */
async function createText({ model, instructions, input, effort = 'low', maxOutputTokens = 4000, label = 'text' }) {
  const response = await createResponse(
    { model: model || models.main(), instructions, input, reasoning: { effort }, max_output_tokens: maxOutputTokens },
    { label }
  );
  const text = (response.output_text || '').trim();
  if (!text) throw new LLMError('AI returned an empty response. Please try again.');
  return text;
}

function findRefusal(response) {
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) if (part.type === 'refusal') return part.refusal;
  }
  return null;
}

function parseJSON(text) {
  if (!text || !text.trim()) throw new LLMError('AI returned an empty response. Please try again.');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/); // tolerate stray code fences
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
    throw new LLMError('AI returned malformed JSON. Please try again.');
  }
}

module.exports = { LLMError, createResponse, createJSON, createText, parseJSON, models };
