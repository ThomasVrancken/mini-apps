const store = require('../db');
const { createResponse, models, LLMError } = require('../llm/openai');
const { buildContext } = require('../llm/context');
const { recordFeedbackEvents } = require('./reflect');

// Autonomous tool-using chat agent (OpenAI Responses API function calling).
// It performs changes through the same db/service functions the HTTP routes
// use, records a human-readable action "chip" for every successful mutation,
// and flips `changed` flags so the client knows which views to refresh.
// Pattern from the Two Pans meals app.

const MAX_TOOL_ROUNDS = 8;
const CHAT_HISTORY_MESSAGES = 20;
const MIN_PREF_LENGTH_RATIO = 0.4; // refuse edits that shrink a field below 40%

// ---------------------------------------------------------------------------
// Tool schemas. strict: true means every property is listed in `required`;
// optional values are typed ['string', 'null'].

const nullableString = (description) => ({ type: ['string', 'null'], description });

const TOOLS = [
  {
    name: 'list_items',
    description: 'List items (compact). status: active, archived, or all.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string', enum: ['active', 'archived', 'all'] } },
      required: ['status'],
    },
  },
  {
    name: 'update_preferences',
    description:
      'Change preference texts. newText is the FULL replacement text of that field: copy the current text verbatim and make a minimal targeted edit (add/adjust/remove one bullet). Refused if a field would shrink below 40% of its length.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string', enum: store.PREFERENCE_FIELDS },
              newText: { type: 'string' },
            },
            required: ['field', 'newText'],
          },
        },
        summary: { type: 'string', description: 'Very short label of the change, max ~6 words' },
      },
      required: ['changes', 'summary'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a new item.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string' }, notes: nullableString('Optional notes, or null') },
      required: ['title', 'notes'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an item. Pass null for fields that should stay unchanged.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string' },
        title: nullableString('New title, or null'),
        notes: nullableString('New notes, or null'),
        status: { type: ['string', 'null'], enum: ['active', 'archived', null] },
      },
      required: ['itemId', 'title', 'notes', 'status'],
    },
  },
  {
    name: 'set_feedback',
    description: 'Thumbs up or down on an item, with an optional note in the user\'s words. null clears it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string' },
        feedback: { type: ['string', 'null'], enum: ['up', 'down', null] },
        note: nullableString('Reason in their words, or null'),
      },
      required: ['itemId', 'feedback', 'note'],
    },
  },
].map((t) => ({ type: 'function', strict: true, ...t }));

const INSTRUCTIONS = `
You are the assistant inside "APP_NAME", a small private app. With your tools you can read and change
everything in the app: preferences and items.

# How to behave
- Be autonomous. When the user states a preference, reports something, or asks for a change, DO it with
  your tools right away, then briefly say what you did. Never ask "shall I?". If something is ambiguous,
  choose the most sensible interpretation, act, and mention the assumption in a few words.
- Only claim changes that a tool call actually made. If a tool returns an error, fix the arguments and
  retry, or briefly explain what went wrong.
- Pure questions are answered from the context below (or read-only tools). Don't change anything for them.
- Replies are short and friendly: 1-3 sentences, plain text. Reply in the user's language.

# Preferences
- update_preferences on the field the wish belongs to. newText = the current text copied verbatim plus
  one added or adjusted "- " bullet. Match the strength of the wish (soft vs hard). If it contradicts an
  existing bullet, edit that bullet instead of adding a conflicting one.
- Leave "learned" alone (the app maintains it) unless explicitly asked.
`.trim();

// ---------------------------------------------------------------------------
// Tool execution

const compact = (i) => ({ id: i.id, title: i.title, status: i.status, feedback: i.feedback });

function createToolRunner(uid, state) {
  const addAction = (action) => state.actions.push(action);
  const flag = (...names) => names.forEach((n) => (state.changed[n] = true));
  const requireItem = async (id) => {
    const item = await store.getItem(uid, id);
    if (!item) throw new Error(`No item with id ${id}`);
    return item;
  };

  return {
    async list_items({ status }) {
      const items = await store.listItems(uid, status === 'all' ? {} : { status });
      return { items: items.map(compact) };
    },

    async update_preferences({ changes, summary }) {
      const current = await store.getPreferences(uid);
      const updates = {};
      for (const { field, newText } of changes || []) {
        if (!store.PREFERENCE_FIELDS.includes(field)) return { error: `Unknown field ${field}` };
        const before = current[field] || '';
        const after = String(newText || '').trim();
        // Guard: models sometimes return only the new bullet instead of the full text.
        if (before.length >= 20 && after.length < before.length * MIN_PREF_LENGTH_RATIO) {
          return {
            error: `Refused: "${field}" would shrink from ${before.length} to ${after.length} characters. newText must be the FULL field text: copy the existing text and make only a targeted edit.`,
          };
        }
        updates[field] = after;
      }
      const { changedFields } = await store.updatePreferences(uid, updates, { updatedBy: 'chat', summary });
      if (changedFields.length === 0) return { ok: true, note: 'Nothing changed (text identical).' };
      flag('preferences');
      addAction({ type: 'preferences', label: `Updated ${changedFields.join(' & ')}: ${summary}` });
      return { ok: true, changedFields };
    },

    async create_item({ title, notes }) {
      if (!title || !title.trim()) return { error: 'title is required' };
      const item = await store.createItem(uid, { title: title.trim().slice(0, 200), notes: notes || null });
      flag('items');
      addAction({ type: 'item', label: `Added ${item.title}`, itemId: item.id });
      return { item: compact(item) };
    },

    async update_item({ itemId, title, notes, status }) {
      await requireItem(itemId);
      const patch = {};
      if (title) patch.title = title.trim().slice(0, 200);
      if (notes !== null && notes !== undefined) patch.notes = notes;
      if (status) patch.status = status;
      if (Object.keys(patch).length === 0) return { error: 'Nothing to update' };
      const item = await store.updateItem(uid, itemId, patch);
      flag('items');
      addAction({ type: 'item', label: `Updated ${item.title}`, itemId: item.id });
      return { item: compact(item) };
    },

    async set_feedback({ itemId, feedback, note }) {
      const before = await requireItem(itemId);
      const item = await store.updateItem(uid, itemId, { feedback, feedbackNote: note || null });
      if (feedback && feedback !== before.feedback) recordFeedbackEvents(uid, 1);
      flag('items');
      const label = feedback === 'up' ? '👍' : feedback === 'down' ? '👎' : 'Cleared feedback on';
      addAction({ type: 'feedback', label: `${label} ${item.title}`, itemId: item.id });
      return { item: compact(item) };
    },
  };
}

async function executeTool(runner, call) {
  const fn = runner[call.name];
  if (!fn) return { error: `Unknown tool ${call.name}` };
  let args;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return { error: 'Arguments were not valid JSON' };
  }
  try {
    return await fn(args);
  } catch (err) {
    // Validation / not-found / LLM errors go back to the model so it can recover or explain.
    console.warn(`[chat] tool ${call.name} failed: ${err.message}`);
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Agent loop

function historyToInput(messages) {
  return messages.map((m) => {
    let content = m.text || '';
    // Show the model what it did in earlier turns.
    if (m.role === 'assistant' && Array.isArray(m.actions) && m.actions.length) {
      content += `\n[actions taken: ${m.actions.map((a) => a.label).join('; ')}]`;
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
  });
}

/**
 * Run the agent for one user message. Returns `{ text, actions, changed }`.
 * Throws LLMError only if nothing was changed yet; after partial progress it
 * returns what was done with an apology, so the user still sees the chips.
 */
async function runChat(uid, message) {
  const [previous, { text: context }] = await Promise.all([store.listChat(uid, CHAT_HISTORY_MESSAGES), buildContext(uid)]);
  const state = { actions: [], changed: { items: false, preferences: false } };
  const runner = createToolRunner(uid, state);
  const base = {
    model: models.main(),
    instructions: `${INSTRUCTIONS}\n\n${context}`,
    tools: TOOLS,
    reasoning: { effort: 'low' },
    max_output_tokens: 8000,
  };

  try {
    let response = await createResponse(
      { ...base, input: [...historyToInput(previous), { role: 'user', content: message }] },
      { label: 'chat r0' }
    );
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const calls = (response.output || []).filter((item) => item.type === 'function_call');
      if (calls.length === 0) break;
      const outputs = [];
      for (const call of calls) {
        console.log(`[chat] tool ${call.name} ${String(call.arguments).slice(0, 300)}`);
        const result = await executeTool(runner, call);
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
      response = await createResponse(
        {
          ...base,
          previous_response_id: response.id,
          input: outputs,
          tool_choice: round === MAX_TOOL_ROUNDS ? 'none' : 'auto', // last round: force a text answer
        },
        { label: `chat r${round}` }
      );
    }
    const text = (response.output_text || '').trim() || (state.actions.length ? 'Done.' : 'Sorry, I have no answer to that.');
    return { text, actions: state.actions, changed: state.changed };
  } catch (err) {
    if (state.actions.length === 0) throw err instanceof LLMError ? err : new LLMError(`Chat failed: ${err.message}`);
    console.error(`[chat] failed after partial progress: ${err.message}`);
    return {
      text: 'Something went wrong partway through, but I did make the changes listed below. Please check and try the rest again.',
      actions: state.actions,
      changed: state.changed,
    };
  }
}

module.exports = { runChat, TOOLS, INSTRUCTIONS };
