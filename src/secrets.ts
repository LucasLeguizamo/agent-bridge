// What may leave an agent's hands: hidden characters are stripped from what agents read, secrets refused on the way in.

// \p{C} is control, format (bidi, zero-width), private-use and unassigned code points. Tab and line feed are visible, and
// removing them would glue words together. Limit: variation selectors are \p{Mn}, so they pass.
const HIDDEN = /[^\P{C}\t\n]/gu;
const ALL_CONTROL = /\p{C}/gu;

export const stripHidden = (text: string) => text.replace(HIDDEN, '');

const isPlainObject = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Strings at any depth, object keys included. Dates and other non-JSON objects pass through untouched. */
export function stripHiddenDeep<T>(value: T): T {
  if (typeof value === 'string') return stripHidden(value) as T;
  if (Array.isArray(value)) return value.map(stripHiddenDeep) as T;
  if (value === null || typeof value !== 'object' || !isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripHidden(k), stripHiddenDeep(v)])) as T;
}

const MAX_DEPTH = 32;
const shallow = (v: unknown, depth: number): boolean => {
  if (v === null || typeof v !== 'object') return true;
  if (depth >= MAX_DEPTH) return false;
  return (Array.isArray(v) ? v : Object.values(v)).every((x) => shallow(x, depth + 1));
};

/** Bounds JSON from an agent. The depth check keeps every recursive walk over stored JSON from overflowing the stack. */
export const jsonWithin = (v: unknown, maxBytes: number) =>
  shallow(v, 0) && Buffer.byteLength(JSON.stringify(v) ?? '') <= maxBytes;

// Best effort and fail closed: patterns catch the usual shapes, not every secret. Keep the values out of errors and logs.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|pk|rk)[-_](?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_\w{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/, // JWT
  /\bBearer\s+[\w.~+/-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i, // credentials in a URL
  /\b[a-f0-9]{32,}\b/i, // Refuses git SHAs too: acceptable, a fact rarely needs one.
  // Labelled values, including JSON. Not bare words: 'the secret garden' and 'la clave es practicar' are ordinary text.
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|private[_ -]?key|contraseña|clave[_ ](?:de[_ ]acceso|secreta))["']?\s*[=:]\s*\S+/i,
  /\b(?:password|passwd|contraseña)\s+(?:is|es)\s+\S+/i,
];
const SECRET_NAME = /(?:^|[._\s-])(?:password|passwd|pwd|secret|api[_-]?key|token|credentials?|private[_-]?key|contraseña|clave[_ -](?:de[_ -]acceso|secreta))(?:$|[._\s-])/i;
// Long mixed-case random strings. Slashes are excluded so that URLs and paths do not count.
const RANDOM_RUN = /[A-Za-z0-9+_-]{40,}={0,2}/g;
const looksRandom = (run: string) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);

const matches = (text: string) =>
  SECRET_SHAPES.some((p) => p.test(text)) || (text.match(RANDOM_RUN) ?? []).some(looksRandom);

// Tested twice: line breaks kept, so a secret alone on its line still has its word boundary, and all gone, so a
// secret split across lines is whole again.
export const containsSecret = (text: string) => matches(stripHidden(text)) || matches(text.replace(ALL_CONTROL, ''));

export const isSecretName = (name: string) => SECRET_NAME.test(name.replace(ALL_CONTROL, ''));

/**
 * Walks strings rather than testing the JSON text: JSON writes a line break as \n, whose `n` hides the word boundary of
 * whatever follows. Object keys are tested as names too, so {"password":"x"} is refused.
 */
export function containsSecretDeep(value: unknown): boolean {
  if (typeof value === 'string') return containsSecret(value);
  if (Array.isArray(value)) return value.some(containsSecretDeep);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => isSecretName(k) || containsSecret(k) || containsSecretDeep(v));
}
