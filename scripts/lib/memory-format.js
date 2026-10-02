/**
 * memory-format.js
 *
 * Single source of truth for the daily memory file convention.
 *
 * Memory files live at context/memory/YYYY-MM-DD.md and follow this shape:
 *
 *   ## Session N
 *
 *   ### Goal
 *   ...
 *
 *   ### Deliverables
 *   - ...
 *
 *   ### Decisions
 *   - ...
 *
 *   ### Open Threads
 *   - ...
 *
 *   Session: 5 deliverables, 3 decisions     ← closing line written by sys-session-close
 *
 * Four scripts and counting depended on the closing pattern and the
 * Open Threads extractor:
 *   - hook-user-prompt.js (startup bundle, recovery flag detection)
 *   - audit-startup.js (cron — abandoned-session audit)
 *   - session-timeout-detector.js (cron — finds idle sessions)
 *   - lint-memory.js (validates memory shape pre-commit)
 *
 * Each had its own copy of the regex and the extractor. A single change
 * to the convention (e.g., translating "Session" to "Sesiune") would
 * have to land in 4 places or silently break 4 features. This module
 * is the single owner; consumers MUST import from here.
 */

/**
 * Closing line pattern. Skills (sys-session-close) write the literal
 * "Session: N deliverables, M decisions" at the end of a memory file
 * to mark a clean session close. Hooks and audits look for this pattern
 * to decide if a session was abandoned.
 */
export const CLOSING_PATTERN = /Session:\s*\d+\s*deliverables/i;

/**
 * Daily-memory date key (YYYY-MM-DD) in the operator's LOCAL calendar day.
 *
 * The memory file is `context/memory/YYYY-MM-DD.md` keyed on the operator's
 * day. Using `toISOString()` (UTC) instead meant that between local midnight
 * and UTC midnight (00:00–03:00 in Romania, UTC+2/+3) every memory-targeting
 * script pointed at YESTERDAY's file: the model writes today's memory (local
 * date), checkpoint-reminder checks yesterday's mtime → "stale" → escalates to
 * a block asking the operator to write the wrong file (AUD-P1-10). Single
 * source of truth so hooks, cron audits, and lint agree on the day boundary.
 *
 * @param {Date} [d=new Date()] date to format
 * @returns {string} YYYY-MM-DD in local time
 */
export function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Returns true if the memory file content has a clean-close pattern.
 * @param {string} content
 * @returns {boolean}
 */
export function isClosed(content) {
  if (typeof content !== 'string' || !content) return false;
  return CLOSING_PATTERN.test(content);
}

/**
 * Extracts the session count from a closing line, if present.
 * Returns N or null.
 */
export function getSessionDeliverableCount(content) {
  if (typeof content !== 'string' || !content) return null;
  const m = content.match(/Session:\s*(\d+)\s*deliverables/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract Open Threads bullet items from a memory file. Returns an
 * array of strings (the text after the bullet). Empty array if the
 * section is absent or empty.
 *
 * Looks at the LAST occurrence of `### Open Threads` (when a memory
 * file has multiple sessions, the latest is what we care about).
 *
 * @param {string} content
 * @returns {string[]}
 */
export function extractOpenThreads(content) {
  if (typeof content !== 'string' || !content) return [];

  const matches = [...content.matchAll(/###\s+Open\s+Threads\s*\n([\s\S]*?)(?=\n###|\n##|$)/gi)];
  if (matches.length === 0) return [];

  const lastSection = matches[matches.length - 1][1];
  return lastSection
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('*'))
    .map((l) => l.replace(/^[-*]\s+/, ''));
}

/**
 * Extract the LAST `### Checkpoint HH:MM` block from a memory file.
 *
 * The sys-checkpoint skill writes the state that no hook can read from the
 * conversation — literal facts (ids, urls, paths, numbers), what was verified
 * and what was NOT, open blockers, and the resume line — into a block of its
 * own, because those categories have no canonical section.
 *
 * Until this existed, that block was write-only: [COMPACT PRESERVATION] carried
 * Open Threads but not the checkpoint, the startup bundle injects only the file
 * path, and memory-digest skips it. Measured on 2026-09-22: 40% of that day's
 * memory file was checkpoint blocks that nothing read back. hook-precompact.js
 * now injects the last one after a compaction.
 *
 * @param {string} content
 * @param {{maxChars?: number}} [opts] defensive cap on the returned body
 * @returns {{title: string, body: string, truncated: boolean} | null}
 */
export function extractLastCheckpoint(content, opts = {}) {
  if (typeof content !== 'string' || !content) return null;

  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 2000;
  const matches = [...content.matchAll(/###\s+(Checkpoint[^\n]*)\n([\s\S]*?)(?=\n###|\n##|$)/gi)];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  const title = last[1].trim();
  // Taie linia de inchidere a sesiunii: cand checkpointul e ultima sectiune a
  // fisierului, `Session: N deliverables, M decisions` cade in corpul lui si ar
  // ajunge in blocul injectat ca si cum ar fi un fapt de checkpoint.
  let body = last[2]
    .split('\n')
    .filter((l) => !CLOSING_PATTERN.test(l))
    .join('\n')
    .trim();
  if (!body) return null;

  const truncated = body.length > maxChars;
  if (truncated) body = `${body.slice(0, maxChars).trimEnd()}\n... (trunchiat — blocul complet e in fisierul zilei)`;

  return { title, body, truncated };
}

/**
 * Required section headers that lint-memory enforces per session.
 * Kept here so future schema changes (add a new required section)
 * are visible from one file.
 */
export const REQUIRED_SECTIONS = ['Goal', 'Deliverables', 'Decisions', 'Open Threads'];
