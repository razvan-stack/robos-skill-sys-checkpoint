#!/usr/bin/env node
/**
 * smoke-checkpoint-reminder.js
 *
 * Guard pentru hook-ul Stop `scripts/checkpoint-reminder.js`.
 *
 * DE CE EXISTA (2026-09-22): reminderul de checkpoint era singurul hook din
 * lantul de memorie fara guard. Textul lui e singurul canal prin care regula
 * „scrie memoria zilei" ajunge la model, iar escaladarea in trei trepte
 * (nudge -> urgent -> block) e logica pe care se bazeaza AUD-P1-04. O regresie
 * in oricare dintre ele n-ar fi fost prinsa de nimic: hook-ul iese 0 pe orice
 * eroare, deci ar fi tacut, nu rosu.
 *
 * Ce verifica, complet OFFLINE (importa builderul, nu forteaza starea memoriei
 * de pe disc — altfel rezultatul ar depinde de ora la care rulezi guard-ul):
 *   1. ESCALADARE — count 0 -> nudge, 1 -> URGENT, 2+ -> decision:block.
 *   2. CONTINUT — calea memoriei zilei, sectiunile cerute, si trimiterea la
 *      skill-ul `sys-checkpoint` (altfel modelul improvizeaza o lista mai
 *      subtire decat cea pe care skill-ul o face deja).
 *   3. MERGE — un block de la enforcement-ul 2brain nu e mascat de nudge-ul de
 *      memorie; textele se compun, iar block-ul castiga.
 *   4. TOGGLE / ANTI-HANG — ROBOS_CHECKPOINT_DISABLED=1 iese 0 fara output;
 *      fara stdin, hook-ul tot iese 0 si nu atarna.
 *   5. DIRECT-RUN GUARD — fisierul invocat direct CHIAR ruleaza hook-ul
 *      (guard-ul adaugat pentru import nu are voie sa-l transforme in no-op).
 */

import './lib/smoke-hook-sink.js'; // sink izolat: o rulare standalone nu polueaza sink-ul de productie
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildMemoryReminder, mergeOutputs, computeMemoryOutput } from './checkpoint-reminder.js';
import { getActiveClient } from './lib/client-context.js';

const __filename = fileURLToPath(import.meta.url);
const ROBOS_ROOT = join(dirname(__filename), '..');
const HOOK_PATH = join(ROBOS_ROOT, 'scripts', 'checkpoint-reminder.js');
const STATE_DIR = join(ROBOS_ROOT, 'data', 'session-state');

const SID = 'smoke-chkrem-guard';
const STATE_FILE = join(STATE_DIR, `${SID}-checkpoint.json`);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function cleanState() { try { unlinkSync(STATE_FILE); } catch { /* absent e ok */ } }

/** Textul dintr-un output de hook Stop, indiferent de forma (block vs additionalContext). */
function textOf(out) {
  if (!out) return '';
  if (out.decision === 'block') return out.reason || '';
  return (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
}

console.log('smoke-checkpoint-reminder');

const NOW = Date.now();
const SKILL_POINTER = 'skills/sys-checkpoint/SKILL.md';

// 1. ESCALADARE + CONTINUT
{
  cleanState();

  const lvl1 = buildMemoryReminder(SID, NOW, 'memory_stale', 45 * 60 * 1000, { unheeded_count: 0, last_reminder_ms: 0 });
  const t1 = textOf(lvl1);
  check('nivel 1: nudge, NU block', lvl1.decision !== 'block' && t1.includes('[CHECKPOINT REMINDER]'), JSON.stringify(Object.keys(lvl1)));
  check('nivel 1: spune de cand nu s-a scris memoria', /45 minutes/.test(t1), t1.slice(0, 80));
  check('nivel 1: numeste calea memoriei zilei', /context\/memory\/\d{4}-\d{2}-\d{2}\.md/.test(t1));
  check('nivel 1: cere sectiunile canonice', t1.includes('### Deliverables') && t1.includes('### Open Threads'));
  check('nivel 1: trimite la skill-ul sys-checkpoint', t1.includes(SKILL_POINTER), t1.slice(-160));

  const lvl2 = buildMemoryReminder(SID, NOW, 'memory_stale', 45 * 60 * 1000, { unheeded_count: 1, last_reminder_ms: 0 });
  const t2 = textOf(lvl2);
  check('nivel 2: URGENT, inca fara block', lvl2.decision !== 'block' && t2.includes('CHECKPOINT URGENT'), t2.slice(0, 60));
  check('nivel 2: avertizeaza ca urmeaza block-ul', /third unheeded reminder/i.test(t2));
  check('nivel 2: pastreaza trimiterea la skill', t2.includes(SKILL_POINTER));

  const lvl3 = buildMemoryReminder(SID, NOW, 'memory_stale', 45 * 60 * 1000, { unheeded_count: 2, last_reminder_ms: 0 });
  const t3 = textOf(lvl3);
  check('nivel 3: decision=block', lvl3.decision === 'block', JSON.stringify(lvl3).slice(0, 80));
  check('nivel 3: block-ul trimite tot la skill', t3.includes(SKILL_POINTER));
  check('nivel 3: spune ca block-ul se ridica singur', /lifts automatically/i.test(t3));

  // Cazul „nu exista inca fisier de memorie" are alt text de motiv.
  const noFile = textOf(buildMemoryReminder(SID, NOW, 'no_memory_file_yet', null, { unheeded_count: 0, last_reminder_ms: 0 }));
  check('fara fisier de memorie: motiv propriu, fara „NaN minutes"', /has not been created yet/.test(noFile) && !/NaN/.test(noFile), noFile.slice(0, 90));

  // Contorul de escaladare chiar se persista (pe el se bazeaza treapta 3).
  let persisted = null;
  try { persisted = JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { /* null */ }
  check('starea de escaladare e scrisa pe disc', !!persisted && typeof persisted.unheeded_count === 'number', JSON.stringify(persisted));

  // Directiva de destinatie apare DOAR cand un client e activ (memoria merge la
  // subiectul muncii, nu automat la clientul activ — CLAUDE.md § Memory Routing).
  const client = getActiveClient();
  if (client) {
    check('client activ: blocul DESTINATION CHECK apare si numeste slug-ul', t1.includes('DESTINATION CHECK') && t1.includes(client.slug));
  } else {
    check('root (fara client): fara DESTINATION CHECK', !t1.includes('DESTINATION CHECK'));
  }

  cleanState();
}

// 2. MERGE — enforcement-ul 2brain nu e mascat de reminderul de memorie
{
  const brainBlock = { decision: 'block', reason: 'BRAIN-GATE: pasul 2brain n-a rulat' };
  const memNudge = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'MEM-NUDGE: scrie memoria' } };

  const merged = mergeOutputs(brainBlock, memNudge);
  check('merge: block-ul 2brain + nudge-ul de memorie → block', merged && merged.decision === 'block');
  check('merge: ambele texte supravietuiesc', merged && /BRAIN-GATE/.test(merged.reason) && /MEM-NUDGE/.test(merged.reason));
  check('merge: doar nudge → fara block', (() => { const m = mergeOutputs(null, memNudge); return !!m && m.decision !== 'block'; })());
  check('merge: niciunul → null (hook tacut)', mergeOutputs(null, null) === null);
}

// 2b. CONTINUARE DE STOP (stop_hook_active, ex. dupa hook-verify-claims.js)
// Un nudge soft (nivel 1-2) ar redeschide tura inca o data; se sare FARA sa se numere. Blocul de
// nivel 3 ramane (AUD-P1-04). `now` in viitor face memoria „veche" indiferent de ora rularii.
{
  cleanState();
  const later = NOW + 10 * 60 * 60 * 1000;
  const soft = computeMemoryOutput(SID, later, true);
  check('continuare + nivel 1: niciun nudge', soft === null, JSON.stringify(soft).slice(0, 80));
  check('continuare + nivel 1: contorul nu se consuma (nicio stare scrisa)', !existsSync(STATE_FILE));
  writeFileSync(STATE_FILE, JSON.stringify({ unheeded_count: 2, last_reminder_ms: 0 }));
  const hard = computeMemoryOutput(SID, later, true);
  check('continuare + nivel 3: ramane block sau tacere, niciodata nudge soft', hard === null || hard.decision === 'block', JSON.stringify(hard).slice(0, 80));
  cleanState();
}

// 3. TOGGLE + ANTI-HANG + DIRECT-RUN GUARD (procese reale)
{
  const run = (input, env = {}) => spawnSync(process.execPath, [HOOK_PATH], {
    cwd: ROBOS_ROOT, input, encoding: 'utf-8', timeout: 10000, env: { ...process.env, ...env },
  });

  const off = run(JSON.stringify({ session_id: SID, hook_event_name: 'Stop' }), { ROBOS_CHECKPOINT_DISABLED: '1' });
  check('toggle disabled → exit 0', off.status === 0, `status=${off.status}`);
  check('toggle disabled → fara output', (off.stdout || '').trim() === '', (off.stdout || '').slice(0, 80));

  const empty = run('');
  check('stdin gol → exit 0 (nu atarna)', empty.status === 0 && empty.signal !== 'SIGTERM', `status=${empty.status} signal=${empty.signal}`);

  // Direct-run guard: invocat direct, hook-ul trebuie sa RULEZE (exit 0 curat).
  // Daca guard-ul ar fi gresit, Stop-ul ar deveni un no-op tacut — exact clasa
  // de esec pe care robOS o trateaza ca pe un bug, nu ca pe o liniste.
  const direct = run(JSON.stringify({ session_id: SID, hook_event_name: 'Stop' }));
  check('invocat direct → exit 0 (guard-ul nu l-a facut no-op)', direct.status === 0, `status=${direct.status} stderr=${(direct.stderr || '').slice(0, 120)}`);
  check('invocat direct → stdout e gol sau JSON valid de hook', (() => {
    const s = (direct.stdout || '').trim();
    if (!s) return true;
    try { const j = JSON.parse(s); return !!j; } catch { return false; }
  })(), (direct.stdout || '').slice(0, 120));

  cleanState();
}

check('fara reziduuri de stare dupa rulare', !existsSync(STATE_FILE));

console.log(`\n${fail === 0 ? 'GREEN' : 'RED'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
