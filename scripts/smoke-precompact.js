#!/usr/bin/env node
/**
 * smoke-precompact.js — Pin: mecanismul [COMPACT PRESERVATION] in doua trepte.
 *
 * Context (corectat 2026-07-05, verificat pe un /compact real + docs):
 * PreCompact NU suporta hookSpecificOutput.additionalContext si stdout-ul lui e
 * IGNORAT de Claude Code. Deci hook-precompact.js NU mai emite JSON — scrie un
 * flag file `data/session-state/{sid}-precompact.json` cu starea determinista,
 * iar hook-user-prompt.js (UserPromptSubmit, care CHIAR suporta
 * additionalContext) il injecteaza si il consuma la primul prompt de dupa
 * compactare. Vezi AGENTS.md, tabela de hooks.
 *
 * Verifica:
 *   1. INREGISTRARE — settings.json are PreCompact cu matchers manual + auto,
 *      ambele rutate la scripts/hook-precompact.js.
 *   2. WRITER — invocat cu payload PreCompact realist, hook-ul iese 0, NU emite
 *      nimic pe stdout (ar fi ignorat/respins de harness) si scrie flag-ul cu
 *      [COMPACT PRESERVATION] + starea git + trigger-ul corect.
 *   3. READER — consumeCompactRecovery() din hook-user-prompt.js intoarce blocul
 *      pentru sesiunea proprie, sterge flag-ul (consum unic), intoarce null la a
 *      doua chemare, null pe alt session id si null pe flag expirat (TTL 24h).
 *   4. ANTI-HANG — fara stdin, hook-ul tot iese 0 si nu atarna.
 *   5. TOGGLE — cu ROBOS_PRECOMPACT_DISABLED=1, iese 0 fara flag scris.
 */

import './lib/smoke-hook-sink.js'; // redirect hook sink so a standalone run does not pollute the production sink (review 2026-07-07)
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, mkdtempSync, utimesSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveMemoryFile } from './hook-precompact.js';
import { consumeCompactRecovery } from './hook-user-prompt.js';
import { extractLastCheckpoint, localDateISO } from './lib/memory-format.js';
import { getMemoryDir } from './lib/client-context.js';

const __filename = fileURLToPath(import.meta.url);
const ROBOS_ROOT = join(dirname(__filename), '..');
const SETTINGS_PATH = join(ROBOS_ROOT, '.claude', 'settings.json');
const HOOK_PATH = join(ROBOS_ROOT, 'scripts', 'hook-precompact.js');
const STATE_DIR = join(ROBOS_ROOT, 'data', 'session-state');

const SID = 'smoke-precompact-1234';
const FLAG = join(STATE_DIR, `${SID}-precompact.json`);

// A student install is a tarball extract (no .git); setup.js never runs `git
// init`. There, hook-precompact.js's git() returns '' and the flag context
// correctly OMITS the "Git branch:"/"Working tree:" line. So we assert git state
// is PRESENT only inside a repo, and assert graceful OMISSION otherwise — instead
// of hard-failing on every student. (fix 2026-07-18: this reddened the student's
// smoke-all / `robos doctor`.)
function isGitRepo() {
  // `--verify HEAD`, nu doar `--git-dir`: un student care a dat `git init` fara
  // niciun commit ARE .git, dar hook-ul nu poate citi branch/tree de acolo, deci
  // nu emite starea git. Oracolul vechi cerea starea git pe baza simplei prezente
  // a repo-ului si pica rosu exact pe configuratia aia (documentata ca reala in
  // smoke-all.js). Adevarul relevant e "exista un HEAD de citit", nu "exista .git".
  return spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROBOS_ROOT, stdio: 'ignore' }).status === 0;
}
const IN_GIT_REPO = isGitRepo();

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function cleanFlag() { try { unlinkSync(FLAG); } catch { /* absent e ok */ } }

/** Ruleaza hook-ul cu un payload pe stdin, marginit la 10s. */
function runHook(payloadObj, env = {}) {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: ROBOS_ROOT,
    input: payloadObj === null ? '' : JSON.stringify(payloadObj),
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, ...env },
  });
  return res;
}

console.log('smoke-precompact');

// 1. INREGISTRARE
let settings;
try {
  settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
} catch (e) {
  check('settings.json parseaza', false, e.message);
}
if (settings) {
  const pc = (settings.hooks && settings.hooks.PreCompact) || [];
  const matchers = pc.map((g) => g.matcher).sort();
  check('PreCompact are matchers manual + auto', JSON.stringify(matchers) === JSON.stringify(['auto', 'manual']), JSON.stringify(matchers));
  // Exec form (2026-07-27): scriptul sta in args[0], nu in command (care e "node").
  // Vezi smoke-hook-cwd-independence.js pentru motiv.
  const cmds = pc.flatMap((g) => (g.hooks || []).map(
    (h) => (Array.isArray(h.args) ? [h.command, ...h.args].join(' ') : h.command)));
  check('ambele matchers ruteaza la hook-precompact.js', cmds.length === 2 && cmds.every((c) => c.includes('hook-precompact.js')), JSON.stringify(cmds));
}

// 2. WRITER — manual + auto
for (const trigger of ['manual', 'auto']) {
  cleanFlag();
  const res = runHook({ session_id: SID, transcript_path: '/tmp/x.jsonl', cwd: ROBOS_ROOT, hook_event_name: 'PreCompact', trigger });
  check(`[${trigger}] exit 0`, res.status === 0, `status=${res.status} stderr=${(res.stderr || '').slice(0, 120)}`);
  check(`[${trigger}] stdout GOL (PreCompact nu are canal de output suportat)`, (res.stdout || '').trim() === '', (res.stdout || '').slice(0, 120));
  check(`[${trigger}] flag-ul exista`, existsSync(FLAG));
  if (existsSync(FLAG)) {
    let data = null;
    try { data = JSON.parse(readFileSync(FLAG, 'utf-8')); } catch { /* null */ }
    check(`[${trigger}] flag JSON valid cu trigger corect`, !!data && data.trigger === trigger, data && data.trigger);
    check(`[${trigger}] context contine [COMPACT PRESERVATION]`, !!data && (data.context || '').includes('[COMPACT PRESERVATION]'));
    if (IN_GIT_REPO) {
      check(`[${trigger}] context contine starea git (branch sau tree)`, !!data && /Git branch:|Working tree:/.test(data.context || ''));
    } else {
      // Student tarball (no .git): the hook must degrade gracefully — omit git
      // state yet still preserve the memory/[COMPACT PRESERVATION] context above.
      check(`[${trigger}] (non-git) OMITE starea git gratios`, !!data && !/Git branch:|Working tree:/.test(data.context || ''));
    }
  } else {
    fail += 3; console.log('  FAIL  [writer] flag lipsa — sar verificarile de continut');
  }
}

// 3. READER — consum unic, doar sesiunea proprie, TTL
{
  // flag-ul ramas de la runda "auto" de mai sus e proaspat
  const got = consumeCompactRecovery(SID);
  check('reader: intoarce blocul pentru sesiunea proprie', typeof got === 'string' && got.includes('[COMPACT PRESERVATION]'));
  check('reader: flag-ul e CONSUMAT (sters)', !existsSync(FLAG));
  check('reader: a doua chemare intoarce null', consumeCompactRecovery(SID) === null);
  check('reader: session id necunoscut → null', consumeCompactRecovery('unknown') === null);
  check('reader: alt session id → null (nu fura flag-uri straine)', consumeCompactRecovery('alt-sid-9999') === null);

  // TTL: flag expirat (25h vechime) → null + consumat
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FLAG, JSON.stringify({ ts: Date.now() - 25 * 3600 * 1000, session_id: SID, trigger: 'auto', context: '[COMPACT PRESERVATION] stale [/COMPACT PRESERVATION]' }), 'utf-8');
  check('reader: flag mai vechi de 24h → null (stale)', consumeCompactRecovery(SID) === null);
  cleanFlag();
}

// 3.5 CHECKPOINT — ultimul bloc `### Checkpoint HH:MM` ajunge in blocul injectat.
// Unitar (offline, independent de starea memoriei de pe disc) + o verificare pe
// rularea reala de mai sus, conditionata de existenta unui bloc in fisierul zilei.
{
  const SAMPLE = [
    '## Session 1', '', '### Open Threads', '- fir vechi', '',
    '### Checkpoint 09:00', '', '**Fapte literale**', '- id vechi ABC', '',
    '### Checkpoint 23:23', '', '**Fapte literale**', '- id nou XYZ-999', '',
    '**Verificari**', '- `node scripts/smoke-x.js`: pass', '',
    '**Reluare:** continua cu pasul 2', '', 'Session: 1 deliverables, 1 decisions', '',
  ].join('\n');

  const cp = extractLastCheckpoint(SAMPLE);
  check('extractLastCheckpoint: ia ULTIMUL bloc, nu primul', !!cp && cp.body.includes('XYZ-999') && !cp.body.includes('ABC'), cp && cp.title);
  check('extractLastCheckpoint: pastreaza titlul cu ora', !!cp && cp.title === 'Checkpoint 23:23', cp && cp.title);
  check('extractLastCheckpoint: se opreste inainte de linia de inchidere', !!cp && !cp.body.includes('Session: 1 deliverables'));
  check('extractLastCheckpoint: pastreaza linia de Reluare', !!cp && cp.body.includes('Reluare'));
  check('extractLastCheckpoint: fara bloc → null', extractLastCheckpoint('## Session 1\n\n### Open Threads\n- x') === null);
  check('extractLastCheckpoint: input invalid → null', extractLastCheckpoint(null) === null && extractLastCheckpoint('') === null);

  const capped = extractLastCheckpoint(`### Checkpoint 10:00\n${'- linie lunga\n'.repeat(400)}`, { maxChars: 500 });
  check('extractLastCheckpoint: plafoneaza si marcheaza trunchierea', !!capped && capped.truncated && capped.body.length < 700, capped && capped.body.length);

  // Pe rularea reala: DACA memoria zilei are un bloc de checkpoint, blocul
  // injectat trebuie sa-l contina. Pe o instalare proaspata (fara checkpoint)
  // verificarea se declara skip, nu fail — altfel guard-ul ar fi verde/rosu
  // dupa starea zilei, nu dupa cod.
  cleanFlag();
  runHook({ session_id: SID, trigger: 'manual' });
  let injected = '';
  try { injected = JSON.parse(readFileSync(FLAG, 'utf-8')).context || ''; } catch { /* gol */ }
  const memFile = join(getMemoryDir(), `${localDateISO()}.md`);
  const memHasCheckpoint = existsSync(memFile) && /###\s+Checkpoint/i.test(readFileSync(memFile, 'utf-8'));
  if (memHasCheckpoint) {
    check('rulare reala: blocul injectat contine ultimul checkpoint', /Last checkpoint written before compaction/.test(injected));
  } else {
    console.log('  SKIP  rulare reala: memoria zilei nu are inca bloc de checkpoint');
  }
  cleanFlag();
}

// 3.6 MIEZUL NOPTII — cand fisierul zilei nu exista inca, starea se citeste din
// fisierul de IERI, dar DOAR cat timp e proaspat. Scenarii pe un director temporar,
// ca rezultatul sa nu depinda de starea reala a memoriei.
{
  const tmp = mkdtempSync(join(tmpdir(), 'robos-precompact-'));
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const today = localDateISO(new Date(now));
  const yday = localDateISO(new Date(now - dayMs));
  const fileFor = (d) => join(tmp, `${d}.md`);

  // a) fisierul de azi exista → se citeste el, fara fallback
  writeFileSync(fileFor(today), '## Session 1\n\n### Open Threads\n- de azi\n', 'utf-8');
  writeFileSync(fileFor(yday), '## Session 9\n\n### Open Threads\n- de ieri\n', 'utf-8');
  let r = resolveMemoryFile(tmp, now);
  check('miezul noptii: fisierul de azi exista → fara fallback', r.readPath === fileFor(today) && r.fallback === false, r.readPath);

  // b) azi lipseste, ieri e proaspat (scris acum 10 minute) → fallback
  unlinkSync(fileFor(today));
  utimesSync(fileFor(yday), new Date(now - 10 * 60 * 1000), new Date(now - 10 * 60 * 1000));
  r = resolveMemoryFile(tmp, now);
  check('miezul noptii: azi lipseste + ieri proaspat → fallback pe ieri', r.readPath === fileFor(yday) && r.fallback === true && r.fallbackDate === yday, JSON.stringify(r));
  check('miezul noptii: scrierile raman pe fisierul de AZI', r.todayPath === fileFor(today), r.todayPath);

  // c) azi lipseste, ieri e vechi (10 ore) → FARA fallback: e o zi noua, nu o
  //    sesiune care a trecut de miezul noptii. Altfel dimineata ai primi in
  //    context starea de ieri ca si cum ar fi curenta.
  utimesSync(fileFor(yday), new Date(now - 10 * 3600 * 1000), new Date(now - 10 * 3600 * 1000));
  r = resolveMemoryFile(tmp, now);
  check('zi noua: ieri vechi de 10h → fara fallback', r.readPath === null && r.fallback === false, JSON.stringify(r));

  // d) director gol → readPath null, fara exceptie
  unlinkSync(fileFor(yday));
  r = resolveMemoryFile(tmp, now);
  check('memorie inexistenta → readPath null, fara exceptie', r.readPath === null && !!r.todayPath);

  // e) checkpointul de ieri chiar ajunge in bloc prin fallback
  writeFileSync(fileFor(yday), [
    '## Session 9', '', '### Open Threads', '- fir de ieri', '',
    '### Checkpoint 23:59', '', '**Fapte literale**', '- id de ieri QWE-777', '',
  ].join('\n'), 'utf-8');
  utimesSync(fileFor(yday), new Date(now - 5 * 60 * 1000), new Date(now - 5 * 60 * 1000));
  r = resolveMemoryFile(tmp, now);
  const cpYday = r.readPath ? extractLastCheckpoint(readFileSync(r.readPath, 'utf-8')) : null;
  check('fallback: checkpointul de ieri e citibil prin readPath', !!cpYday && cpYday.body.includes('QWE-777'), r.readPath);

  rmSync(tmp, { recursive: true, force: true });
}

// 4. ANTI-HANG — fara stdin (input gol). Trebuie sa iasa 0 prompt, fara sa atarne.
{
  const res = runHook(null);
  check('stdin gol → exit 0 (nu atarna)', res.status === 0 && res.signal !== 'SIGTERM', `status=${res.status} signal=${res.signal}`);
}

// 5. TOGGLE
{
  cleanFlag();
  const res = runHook({ session_id: SID, trigger: 'manual' }, { ROBOS_PRECOMPACT_DISABLED: '1' });
  check('toggle disabled → exit 0', res.status === 0, `status=${res.status}`);
  check('toggle disabled → fara flag scris', !existsSync(FLAG));
  cleanFlag();
}

console.log(`\n${fail === 0 ? 'GREEN' : 'RED'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
