const { GoogleAuth } = require('google-auth-library');

// Alternative LLM provider: Gemini on Vertex AI over plain REST, authenticated
// with Application Default Credentials (no API key anywhere). Needs
// `google-auth-library` in the root package.json and, in production, the App
// Engine default service account needs roles/aiplatform.user.
//
// Pattern from the newsfeed app (used there for per-item Q&A with Google
// Search grounding and for the structured "rewrite my preferences" agent).

const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

// On App Engine / Cloud Functions / Cloud Run, ADC resolves from the service
// account via the metadata server. Locally, without
// `gcloud auth application-default login`, fall back to the gcloud CLI token.
async function getAccessToken() {
  try {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    return token;
  } catch (err) {
    if (process.env.GAE_ENV || process.env.K_SERVICE) throw err; // deployed: don't mask real failures
    console.warn('ADC unavailable, falling back to `gcloud auth print-access-token` (local dev only)');
    const { execSync } = require('child_process');
    return execSync('gcloud auth print-access-token').toString().trim();
  }
}

/**
 * Call Gemini generateContent.
 * @param {object} opts
 * @param {string} [opts.systemInstruction]
 * @param {Array<{role: 'user'|'model', text: string}>} opts.contents  conversation turns
 * @param {Array} [opts.tools]  e.g. [{ googleSearch: {} }] for grounding
 * @param {object} [opts.generationConfig]  merged over the defaults
 */
async function callGemini({ systemInstruction, contents, tools, generationConfig }) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT is not set');
  const token = await getAccessToken();
  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents: contents.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    ...(tools ? { tools } : {}),
    // Gemini 2.5 "thinking" tokens count against maxOutputTokens: keep it roomy
    // for anything that returns long documents.
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192, ...generationConfig },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Don't forward the raw body to clients; log it server-side only.
    console.error(`[gemini] ${res.status}: ${text.slice(0, 500)}`);
    const err = new Error(`AI request failed (${res.status}). Please try again.`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

function extractText(geminiResponse) {
  const parts = (geminiResponse && geminiResponse.candidates && geminiResponse.candidates[0] && geminiResponse.candidates[0].content && geminiResponse.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

/**
 * Structured output: pass an OpenAPI-style schema (Vertex uses upper-case
 * types: OBJECT, STRING, ARRAY, INTEGER, BOOLEAN). Returns the parsed object.
 */
async function callGeminiJSON({ systemInstruction, contents, responseSchema, maxOutputTokens = 32768, temperature = 0.1 }) {
  const response = await callGemini({
    systemInstruction,
    contents,
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json', responseSchema },
  });
  const text = extractText(response);
  if (!text.trim()) throw Object.assign(new Error('AI returned an empty response. Please try again.'), { status: 502 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('AI returned malformed JSON. Please try again.'), { status: 502 });
  }
}

/** Grounding citations (Google Search tool). URIs are opaque vertexaisearch redirect links. */
function extractCitations(geminiResponse) {
  const candidate = geminiResponse && geminiResponse.candidates && geminiResponse.candidates[0];
  const chunks = (candidate && candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks) || [];
  const seen = new Set();
  const citations = [];
  for (const c of chunks) {
    if (!c.web || !c.web.uri || seen.has(c.web.uri)) continue;
    seen.add(c.web.uri);
    citations.push({ title: c.web.title || c.web.uri, url: c.web.uri });
  }
  return citations;
}

module.exports = { callGemini, callGeminiJSON, extractText, extractCitations };
