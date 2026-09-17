const store = require('../db');
const { localDate, TIME_ZONE } = require('../http');

// Builds the shared "who I am / what happened" block that EVERY AI call gets
// (generation, edits, chat agent, reflection), so they all reason from the
// same facts. Returns the rendered text and the raw data (for reuse).

const MAX_LIKED = 30;
const MAX_DISLIKED = 30;
const MAX_ACTIVE = 50;

const FIELD_LABELS = {
  about: 'About me / us',
  likes: 'Likes',
  dislikes: 'Dislikes',
  learned: 'Learned from feedback (maintained by the app)',
};

const section = (title, lines, empty = '(none)') => `## ${title}\n${lines.length ? lines.join('\n') : empty}`;

async function loadContextData(uid) {
  const [preferences, items] = await Promise.all([store.getPreferences(uid), store.listItems(uid)]);
  return { today: localDate(), preferences, items };
}

function renderContext({ today, preferences, items }) {
  const liked = items.filter((i) => i.feedback === 'up').slice(0, MAX_LIKED);
  const disliked = items.filter((i) => i.feedback === 'down').slice(0, MAX_DISLIKED);
  const active = items.filter((i) => i.status === 'active').slice(0, MAX_ACTIVE);
  return [
    `# Context\nToday is ${today} (${TIME_ZONE}).`,
    // Label every section with its field key so the chat agent knows what to edit.
    ...Object.entries(FIELD_LABELS).map(([field, label]) =>
      section(`Preferences: ${label} [field: ${field}]`, preferences[field] ? [preferences[field].trim()] : [], '(empty)')
    ),
    section('Active items', active.map((i) => `- [${i.id}] ${i.title}${i.feedback ? ` (feedback: ${i.feedback})` : ''}`)),
    section('Liked (thumbs up)', liked.map((i) => `- ${i.title}${i.feedbackNote ? ` (note: "${i.feedbackNote}")` : ''}`)),
    section('Disliked (thumbs down)', disliked.map((i) => `- ${i.title}${i.feedbackNote ? `: "${i.feedbackNote}"` : ''}`)),
  ].join('\n\n');
}

async function buildContext(uid) {
  const data = await loadContextData(uid);
  return { text: renderContext(data), data };
}

module.exports = { buildContext, loadContextData, renderContext };
