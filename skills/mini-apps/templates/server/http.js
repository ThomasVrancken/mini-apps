// Small HTTP helpers shared by routes and services: a typed error that the
// Express error handler turns into `{error}` with the right status, a few
// input validators, and secret redaction for logs.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (message = 'Not found') => new HttpError(404, message);

/** Validate a required string field; returns the trimmed value. */
function requiredString(body, key, { max = 2000 } = {}) {
  const v = body && body[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  if (v.length > max) throw badRequest(`${key} is too long (max ${max} chars)`);
  return v.trim();
}

/** Validate an optional string field; returns trimmed string, null, or undefined (absent). */
function optionalString(body, key, { max = 2000 } = {}) {
  if (!body || !(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${key} is too long (max ${max} chars)`);
  return t || null;
}

/** Today's date (YYYY-MM-DD) in the app's time zone, optionally shifted by N days. */
const TIME_ZONE = process.env.APP_TIME_ZONE || 'Europe/Amsterdam';
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(d);
}

// Never let anything resembling a key leak into logs or client errors.
// Extend the pattern if you use other key formats.
const redact = (s) => String(s || '').replace(/sk-[A-Za-z0-9_*-]{6,}/g, 'sk-***');

module.exports = { HttpError, badRequest, notFound, requiredString, optionalString, localDate, redact, TIME_ZONE };
