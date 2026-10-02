#!/usr/bin/env node
/**
 * checkpoint-reminder.js
 *
 * Hook handler pentru evenimentul Stop (la sfarsitul fiecarui turn al modelului).
 * Verifica daca au trecut >30min de la ultima scriere in memoria zilei.
 * Daca da, injecteaza un reminder ca model-ul sa scrie checkpoint inainte de
 * urmatorul turn.
 *
 * Output:
 *  - Daca checkpoint e necesar: JSON cu hookSpecificOutput.additionalContext
 *  - Altfel: niciun output (exit 0)
 *
 * Niciodata nu blocheaza — daca apar erori, exit 0 silentios.
 *
 * Configurare:
 *  - Threshold poate fi suprascris cu env var ROBOS_CHECKPOINT_MIN (default 30)
 *  - Dezactivare: set ROBOS_CHECKPOINT_DISABLED=1
 */

import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env-loader.js';
import { logHookError } from './lib/hook-error-sink.js';
import { parseHookStdin } from './lib/read-stdin.js';
import { atomicWrite } from './lib/atomic-write.js';
import { getMemoryDir, getActiveClient } from './lib/client-context.js';
import { localDateISO } from './lib/memory-format.js';
import { evaluateClose } from './brain-ingest-reminder.js';

// Load .env BEFORE any process.env reads (Claude Code spawns hooks with clean env)
loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROBOS_ROOT = join(__dirname, '..');
const STATE_DIR = join(ROBOS_ROOT, 'data', 'session-state');

// Number.isFinite guard: a non-numeric ROBOS_CHECKPOINT_MIN (typo, empty) would
// make parseInt return NaN, and every `> thresholdMs` comparison false → the
// checkpoint reminder silently disabled (AUD-P1-04). Fall back to 30.
const _thresholdRaw = parseInt(process.env.ROBOS_CHECKPOINT_MIN || '30', 10);
const DEFAULT_THRESHOLD_MIN = Number.isFinite(_thresholdRaw) && _thresholdRaw > 0 ? _thresholdRaw : 30;

function todayISO() {
  // Local calendar day — the memory file is keyed on the operator's day, not
  // UTC (AUD-P1-10). See memory-format.localDateISO.
  return localDateISO();
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Determina cand a fost ultima oara cand memoria zilei a fost actualizata.
 * Resolves through getMemoryDir() — picks client memory if a client is active.
 * Returneaza un timestamp ms sau null daca fisierul nu exista.
 */
function lastMemoryWriteMs() {
  const path = join(getMemoryDir(), `${todayISO()}.md`);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Citeste starea de checkpoint pentru aceasta sesiune.
 * Stocat in data/session-state/{session_id}-checkpoint.json.
 * Tracks: ultimul reminder + counter pentru escaladare progresiva.
 */
function readCheckpointState(sessionId) {
  const path = join(STATE_DIR, `${sessionId}-checkpoint.json`);
  if (!existsSync(path)) return { last_reminder_ms: 0, unheeded_count: 0, last_memory_write_ms: 0 };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { last_reminder_ms: 0, unheeded_count: 0, last_memory_write_ms: 0 };
  }
}

function writeCheckpointState(sessionId, state) {
  ensureDir(STATE_DIR);
  const path = join(STATE_DIR, `${sessionId}-checkpoint.json`);
  // atomicWrite, not writeFileSync: sibling Stop hooks (note-candidates) read
  // this state file concurrently — a torn read would drop the anti-stacking
  // guard (AUD-P1-15).
  atomicWrite(path, JSON.stringify(state, null, 2));
}

/**
 * Extrage textul (reason / additionalContext) dintr-un output de hook Stop, sau null.
 */
function outText(out) {
  if (!out) return null;
  if (out.decision === 'block') return out.reason;
  if (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) return out.hookSpecificOutput.additionalContext;
  return null;
}

/**
 * Uneste DETERMINIST output-ul enforcement-ului 2brain cu cel al reminder-ului de memorie,
 * intr-un singur output de hook Stop (Claude Code citeste un singur JSON per hook).
 *
 * FIX (Audit 2026-06-19, Codex #2): inainte, reminder-ul de memorie facea early-return si
 * enforcement-ul 2brain (evaluateClose) nu se mai evalua deloc cand memoria era stale → la
 * inchidere cu memorie veche, block-ul 2brain era mascat. Acum ambele se evalueaza mereu si
 * se compun: block-ul 2brain (poarta de lifecycle) primeste prioritate de text; daca oricare
 * cere block, output-ul final e block.
 */
function mergeOutputs(brainOut, memOut) {
  const brainText = outText(brainOut);
  const memText = outText(memOut);
  if (!brainText && !memText) return null;
  const reason = [brainText, memText].filter(Boolean).join('\n\n');
  const anyBlock = brainOut?.decision === 'block' || memOut?.decision === 'block';
  if (anyBlock) return { decision: 'block', reason };
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } };
}

async function main() {
  if (process.env.ROBOS_CHECKPOINT_DISABLED === '1') {
    process.exit(0);
  }

  let payload = {};
  try {
    const stdin = readFileSync(0, 'utf-8');
    payload = parseHookStdin(stdin); // strips BOM (PowerShell pipe) before parse
  } catch (e) {
    logHookError('checkpoint-reminder:stdin-parse', e);
    process.exit(0);
  }

  // Validate session_id before using as filename. Claude Code sends UUIDs
  // but untrusted JSON is never trusted for a path component.
  const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
  const rawSessionId = payload.session_id;
  const sessionId = (typeof rawSessionId === 'string' && SESSION_ID_RE.test(rawSessionId))
    ? rawSessionId
    : 'unknown';
  const now = Date.now();

  // Enforcement 2brain (inchidere fara stamp) — evaluat MEREU, independent de starea memoriei.
  // (Pliat in acest hook deja inregistrat ca sa se activeze fara restart — vezi brain-ingest-reminder.js.)
  let brainOut = null;
  try {
    brainOut = evaluateClose(payload, now);
  } catch (e) {
    logHookError('checkpoint-reminder:brain-ingest', e);
  }

  // Reminder de memorie — calculat fara early-exit, ca sa se poata compune cu brainOut.
  let memOut = null;
  try {
    memOut = computeMemoryOutput(sessionId, now, payload.stop_hook_active === true);
  } catch (e) {
    logHookError('checkpoint-reminder:memory', e);
  }

  const merged = mergeOutputs(brainOut, memOut);
  if (merged) process.stdout.write(JSON.stringify(merged));
  process.exit(0);
}

/**
 * Calculeaza output-ul reminder-ului de memorie (sau null), fara sa scrie la stdout / iasa.
 * Pastreaza logica de escaladare (counter unheeded) + reset cand memoria a fost scrisa.
 */
function computeMemoryOutput(sessionId, now, inContinuation = false) {
  const thresholdMs = DEFAULT_THRESHOLD_MIN * 60 * 1000;
  // Inside a Stop continuation (stop_hook_active, e.g. after hook-verify-claims.js), a soft nudge
  // (levels 1-2) would re-open the turn once more; skip it WITHOUT counting it, so escalation state
  // is unchanged. Level 3 keeps blocking every Stop, continuation or not (AUD-P1-04).
  const softOnly = (st) => inContinuation && ((st.unheeded_count || 0) + 1) < 3;
  const lastWrite = lastMemoryWriteMs();
  const state = readCheckpointState(sessionId);

  // Daca memoria a fost scrisa dupa ultimul reminder, RESET counter (model a respectat).
  if (lastWrite && lastWrite > state.last_reminder_ms && state.unheeded_count > 0) {
    writeCheckpointState(sessionId, { ...state, unheeded_count: 0, last_memory_write_ms: lastWrite });
  }
  // Re-citeste starea ca sa folosim counter-ul post-reset la escaladare.
  const st = readCheckpointState(sessionId);

  // Caz 1: nu exista memorie pentru azi → reminder daca sesiunea a inceput de >threshold
  if (!lastWrite) {
    const sessionMarker = join(STATE_DIR, `${sessionId}.json`);
    if (existsSync(sessionMarker)) {
      try {
        const data = JSON.parse(readFileSync(sessionMarker, 'utf-8'));
        const startedMs = new Date(data.started_at).getTime();
        const overdue = (now - startedMs) > thresholdMs;
        // Level 3+ (block) bypasses the anti-spam window: while the condition
        // persists, EVERY Stop stays blocked — otherwise "block until write" is
        // just one-shot per 30-min window and the next Stop slips through with
        // no memory written (AUD-P1-04). The anti-spam gate only throttles the
        // soft nudges (levels 1-2).
        if (overdue && ((st.unheeded_count || 0) >= 3 || (now - st.last_reminder_ms) > thresholdMs)) {
          if (softOnly(st)) return null;
          return buildMemoryReminder(sessionId, now, 'no_memory_file_yet', null, st);
        }
      } catch { /* noop */ }
    }
    return null;
  }

  // Caz 2: memorie exista, dar nu a fost atinsa de >threshold
  const sinceWrite = now - lastWrite;
  if (sinceWrite > thresholdMs && ((st.unheeded_count || 0) >= 3 || (now - st.last_reminder_ms) > thresholdMs)) {
    if (softOnly(st)) return null;
    return buildMemoryReminder(sessionId, now, 'memory_stale', sinceWrite, st);
  }
  return null;
}

function buildMemoryReminder(sessionId, now, reason, sinceWriteMs, state) {
  const newCount = (state.unheeded_count || 0) + 1;
  writeCheckpointState(sessionId, {
    ...state,
    last_reminder_ms: now,
    unheeded_count: newCount,
  });

  const minSince = sinceWriteMs ? Math.floor(sinceWriteMs / 60000) : null;
  const reasonText = reason === 'no_memory_file_yet'
    ? 'The session has run past the checkpoint threshold and today\'s memory file has not been created yet.'
    : `Today's memory has not been updated for ${minSince} minutes.`;

  // Build client-aware memory path so escalation messages point to the right place.
  const memoryDir = getMemoryDir();
  const memoryRel = memoryDir
    .slice(ROBOS_ROOT.length + 1)
    .replace(/\\/g, '/');
  const memoryFileRel = `${memoryRel}/${todayISO()}.md`;

  // Client-aware subject check: robOS routes memory by the ACTIVE client but has
  // no signal for the work's SUBJECT. When a client is active, name it and prompt
  // the model to confirm this turn belongs there — personal/cross-client work can
  // otherwise land silently in the wrong workspace (incident: a personal health
  // session written into a business client). No active client (root) → empty string.
  const activeClient = getActiveClient();
  const clientNotice = activeClient
    ? `DESTINATION CHECK: this memory routes to the active client "${activeClient.slug}". Confirm THIS turn's subject actually belongs to "${activeClient.slug}". If it is personal work (health, finance) or another client, switch the client first or write to the correct workspace's absolute path — memory must follow the SUBJECT, not just the active client.`
    : '';

  // Escaladare in 3 trepte:
  //  Level 1 (count=1): nudge soft
  //  Level 2 (count=2): URGENT, language stricter
  //  Level 3+ (count>=3): block decision — forteaza model sa continue lucrul
  if (newCount >= 3) {
    // Block decision — Claude Code va impiedica modelul sa termine
    return {
      decision: 'block',
      reason: `${reasonText} This is the ${newCount}th unheeded reminder — the stop is blocked so you write today's memory NOW. Add the Goal/Deliverables/Decisions/Open Threads sections to ${memoryFileRel}, then continue (for a full checkpoint follow \`skills/sys-checkpoint/SKILL.md\`). This block lifts automatically once the memory receives a write.${clientNotice ? ' ' + clientNotice : ''}`,
    };
  }

  const urgency = newCount === 1 ? 'CHECKPOINT REMINDER' : 'CHECKPOINT URGENT (2nd reminder)';
  const lines = [
    `[${urgency}]`,
    reasonText,
    '',
    `Before the next turn, write a mini-checkpoint in \`${memoryFileRel}\`:`,
    '  - Add to `### Deliverables` what you produced (files touched, decisions)',
    '  - Add to `### Open Threads` what is unfinished',
    '  - If the file does not exist, create it with the standard structure (## Session N → Goal/Deliverables/Decisions/Open Threads)',
    '',
    // The skill packages this same work, plus the categories that have no canonical
    // section (literal facts, verifications, blockers, resume line) — and its block
    // is what hook-precompact.js injects back after a compaction. Naming it here
    // stops the model from improvising a thinner version of work that already exists.
    'For a full checkpoint (before /compact, or when the session carries state worth restating), follow `skills/sys-checkpoint/SKILL.md` instead of improvising this list.',
    '',
  ];

  if (newCount === 2) {
    lines.push('WARNING: after the third unheeded reminder, the stop is blocked until you write the memory. Write it now.');
  } else {
    lines.push('This protects against context crashes and lost work. Not visible to the operator — it is operational.');
  }

  if (clientNotice) {
    lines.push('', clientNotice);
  }

  lines.push(`[/${urgency}]`);

  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: lines.join('\n'),
    },
  };
}

// Direct-run guard — acelasi contract ca in hook-user-prompt.js: hook-ul ruleaza
// doar cand fisierul e invocat direct (asa il porneste Claude Code, exec form),
// iar un import (smoke-checkpoint-reminder.js) capata functiile fara sa declanseze
// fluxul real (citire stdin, scriere de state, stdout de hook).
const __invokedFile = process.argv[1] && process.argv[1].replace(/\\/g, '/');
const __thisFile = fileURLToPath(import.meta.url).replace(/\\/g, '/');
if (__invokedFile === __thisFile) {
  main().catch((e) => {
    logHookError('checkpoint-reminder', e);
    process.exit(0);
  });
}

// Exportate pentru guard: textul reminderului e singurul canal prin care regula
// ajunge la model, si pana acum nu-l verifica nimic.
export { buildMemoryReminder, mergeOutputs, computeMemoryOutput };
