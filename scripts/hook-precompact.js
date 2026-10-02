#!/usr/bin/env node
/**
 * hook-precompact.js
 *
 * Hook handler pentru evenimentul PreCompact (chiar inainte ca Claude Code sa
 * comprime conversatia — manual prin /compact, sau auto la limita de tokeni).
 *
 * PROBLEMA pe care o rezolva: CLAUDE.md are sectiunea „/compact Preservation"
 * care cere ca, inainte de compactare, sa se scrie in memoria zilei fisierele
 * modificate, branch-ul git, TODO-urile active, rezultatele testelor si
 * deciziile cheie. Pana acum era o regula ADVISORY — functiona doar daca
 * model-ul isi amintea sa scrie inainte de compactare. Daca uita, contextul se
 * pierdea (memoria zilei supravietuieste compactarii; conversatia nu).
 *
 * Acest hook face regula DETERMINISTA in DOUA trepte (mecanism corectat
 * 2026-07-05, dupa verificarea docs Claude Code pe un /compact real):
 *
 *   Contractul REAL al evenimentului PreCompact (code.claude.com/docs/en/hooks):
 *     - matchers: "manual" | "auto"
 *     - stdin: { session_id, transcript_path, cwd, hook_event_name, trigger }
 *     - output: DOAR decision:block la nivel top. PreCompact NU suporta
 *       hookSpecificOutput.additionalContext (validarea JSON respinge), iar
 *       stdout-ul lui e IGNORAT (merge doar in debug log). Nu exista nicio cale
 *       suportata de a injecta context in fereastra de sumarizare.
 *
 *   Treapta 1 (acest script, la PreCompact): calculeaza determinist starea
 *   ([COMPACT PRESERVATION]: branch git + fisiere necomise + calea memoriei
 *   zilei + Open Threads curente + ultimul bloc `### Checkpoint`) si o scrie
 *   intr-un flag file
 *   `data/session-state/{session_id}-precompact.json`. Zero stdout.
 *
 *   Treapta 2 (hook-user-prompt.js, UserPromptSubmit — eveniment care CHIAR
 *   suporta additionalContext): la primul prompt de DUPA compactare gaseste
 *   flag-ul sesiunii, injecteaza blocul in context si il consuma (delete).
 *   Modelul primeste starea exact cand reia lucrul pe contextul comprimat.
 *
 * Niciodata nu blocheaza — pe orice eroare iese 0 silentios (eroarea -> sink).
 *
 * Dezactivare: set ROBOS_PRECOMPACT_DISABLED=1
 *
 * NOTA: fiind un eveniment NOU in settings.json, activarea cere un restart al
 * sesiunii Claude Code (hook-urile pentru evenimente noi se inregistreaza la
 * pornire). Pe sesiunile existente nu se aprinde retroactiv.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { loadEnv } from './lib/env-loader.js';
import { logHookError } from './lib/hook-error-sink.js';
import { getMemoryDir, getActiveClient } from './lib/client-context.js';
import { extractOpenThreads, extractLastCheckpoint, localDateISO } from './lib/memory-format.js';
import { readStdinWithTimeout, parseHookStdin } from './lib/read-stdin.js';
import { atomicWrite } from './lib/atomic-write.js';

// Load .env BEFORE any process.env reads (Claude Code spawns hooks with clean env)
loadEnv();

const __filename = fileURLToPath(import.meta.url);
const ROBOS_ROOT = join(dirname(__filename), '..');
const SESSION_STATE_DIR = join(ROBOS_ROOT, 'data', 'session-state');
// Acelasi contract de sanitizare ca in hook-user-prompt.js: session_id devine
// componenta de nume de fisier, deci nu avem incredere in JSON extern.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// Ziua locala (AUD-P1-10) se rezolva prin localDateISO, direct in
// resolveMemoryFile — singurul loc care mai are nevoie de ea.

/**
 * Ruleaza o comanda git scurta, marginita la 2s, cu CWD=ROOT. Intoarce stdout
 * trim-uit sau '' (git poate lipsi / repo poate fi absent — nefatal).
 */
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: ROBOS_ROOT,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Fereastra in care fisierul de IERI mai conteaza pentru sesiunea curenta.
// Cazul pe care il rezolva: sesiunea trece de miezul noptii (observat 2026-09-23,
// 00:01) — memoria sesiunii e in fisierul de ieri, hook-ul cauta fisierul de azi,
// care inca nu exista, si injecteaza un bloc fara fire si fara checkpoint exact
// cand sesiunea e cea mai lunga si mai incarcata. Sase ore tin noaptea intreaga
// si NU tarasc starea de ieri intr-o dimineata noua: la 9:00 fisierul de ieri e
// vechi de mult mai mult, deci fallback-ul nu se aprinde.
const MIDNIGHT_FALLBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Alege fisierul de memorie din care se CITESTE starea (fire + checkpoint).
 *
 * Scrierile raman mereu pe fisierul zilei curente (`todayPath`) — fallback-ul e
 * doar pentru citire, altfel o sesiune de noapte ar continua sa ingroape starea
 * intr-o zi incheiata.
 *
 * @param {string} memoryDir directorul de memorie (root sau al clientului activ)
 * @param {number} [now=Date.now()]
 * @returns {{readPath: string|null, todayPath: string, fallback: boolean, fallbackDate: string|null}}
 */
export function resolveMemoryFile(memoryDir, now = Date.now()) {
  const todayPath = join(memoryDir, `${localDateISO(new Date(now))}.md`);
  if (existsSync(todayPath)) {
    return { readPath: todayPath, todayPath, fallback: false, fallbackDate: null };
  }

  const prevDate = localDateISO(new Date(now - 24 * 60 * 60 * 1000));
  const prevPath = join(memoryDir, `${prevDate}.md`);
  if (existsSync(prevPath)) {
    try {
      if (now - statSync(prevPath).mtimeMs <= MIDNIGHT_FALLBACK_MS) {
        return { readPath: prevPath, todayPath, fallback: true, fallbackDate: prevDate };
      }
    } catch { /* nefatal — tratam ca inexistent */ }
  }

  return { readPath: null, todayPath, fallback: false, fallbackDate: null };
}

/**
 * Construieste blocul [COMPACT PRESERVATION]. E citit de MODEL la primul prompt
 * de dupa compactare (injectat de hook-user-prompt.js), nu de sumarizator —
 * deci vorbeste despre compactare la trecut si cere reconciliere cu sumarul.
 */
function buildPreservationContext(trigger) {
  const lines = [];
  lines.push('[COMPACT PRESERVATION]');
  lines.push(
    `The conversation was compacted (${trigger || 'auto'}) at ${new Date().toISOString()}. ` +
    'The summary may have dropped in-flight state. The following was captured DETERMINISTICALLY at compaction time — ' +
    'treat it as ground truth and reconcile it with the summary before continuing:'
  );
  lines.push('');

  // 1) Stare git reala (determinista — garantata in sumar chiar daca a fost uitata)
  const branch = git('rev-parse --abbrev-ref HEAD');
  const porcelain = git('status --porcelain');
  if (branch) lines.push(`- Git branch: ${branch}`);
  if (porcelain) {
    const files = porcelain.split('\n').map((l) => l.trim()).filter(Boolean);
    const shown = files.slice(0, 40);
    lines.push(`- Uncommitted changes (${files.length}):`);
    for (const f of shown) lines.push(`    ${f}`);
    if (files.length > shown.length) lines.push(`    ... +${files.length - shown.length} more`);
  } else if (branch) {
    lines.push('- Working tree: clean (no uncommitted changes)');
  }

  // 2) Memoria zilei + Open Threads (firele deschise = inregistrarea durabila)
  const client = getActiveClient();
  const memoryDir = getMemoryDir();
  const resolved = resolveMemoryFile(memoryDir);
  const memoryPath = resolved.todayPath;
  const memoryRel = memoryPath.slice(ROBOS_ROOT.length + 1).replace(/\\/g, '/');
  const readRel = resolved.readPath
    ? resolved.readPath.slice(ROBOS_ROOT.length + 1).replace(/\\/g, '/')
    : null;
  // client is the state OBJECT {slug,name,...} — use .slug, not the object
  // (bare interpolation printed "[object Object]"; sibling of AUD-P1-01).
  lines.push(`- Durable record: today's memory at \`${memoryRel}\`${client ? ` (active client: ${client.slug})` : ''}.`);

  if (resolved.fallback) {
    lines.push(
      `- NOTE: today's memory file does not exist yet (the session crossed midnight). ` +
      `Threads and checkpoint below were read from \`${readRel}\` (${resolved.fallbackDate}). ` +
      `New writes still go to \`${memoryRel}\`.`
    );
  }

  let checkpoint = null;
  if (resolved.readPath) {
    try {
      const memoryContent = readFileSync(resolved.readPath, 'utf-8');
      const threads = extractOpenThreads(memoryContent);
      if (threads.length) {
        lines.push('- Open Threads at compaction time (verify they survived in the summary):');
        for (const t of threads.slice(0, 15)) lines.push(`    - ${t}`);
      }
      // Ultimul bloc `### Checkpoint HH:MM` — scris de skill-ul sys-checkpoint
      // FIX de clasa (2026-09-22): categoriile fara sectiune canonica (fapte
      // literale, ce a fost verificat si ce NU, blocaje, linia de reluare)
      // traiau intr-un bloc pe care nimic nu-l mai citea — nici blocul asta,
      // nici startup bundle-ul, nici memory-digest. Masurat pe 3 compactari
      // reale: 0 din 3 reluari au deschis fisierul zilei ca sa-l recupereze.
      checkpoint = extractLastCheckpoint(memoryContent, { maxChars: 2000 });
    } catch { /* nefatal */ }
  }

  if (checkpoint) {
    lines.push('');
    lines.push(`- Last checkpoint written before compaction (\`### ${checkpoint.title}\`, from ${memoryRel}):`);
    for (const l of checkpoint.body.split('\n')) lines.push(`    ${l}`);
  }

  // 3) Contractul: ce se pierde cel mai des la compactare (nu e in git/memorie)
  lines.push('');
  lines.push('If the summary lost any of the following, recover it before continuing:');
  lines.push('  - Active TODOs not yet completed (re-create the TodoWrite list)');
  lines.push('  - Test/smoke results (which ran, pass or fail, what failed)');
  lines.push('  - Key decisions made this session and the reason (not obvious from the diff)');
  lines.push('');
  lines.push(
    `Anything durable that is missing from today's memory goes into \`${memoryRel}\` under ` +
    '`### Open Threads` NOW. The memory file survives compaction; the conversation does not.'
  );
  lines.push('[/COMPACT PRESERVATION]');

  return lines.join('\n');
}

async function main() {
  // Global safety net: un hook nu trebuie sa atarne niciodata. Daca ceva
  // neprevazut blocheaza event loop-ul, fortam iesirea curata.
  const safety = setTimeout(() => process.exit(0), 4000);
  safety.unref?.();

  if (process.env.ROBOS_PRECOMPACT_DISABLED === '1') {
    process.exit(0);
  }

  let payload = {};
  try {
    const stdin = await readStdinWithTimeout(500);
    payload = parseHookStdin(stdin); // strips BOM (PowerShell pipe) before parse (AUD-P1-14)
  } catch (e) {
    logHookError('hook-precompact:stdin-parse', e);
    process.exit(0);
  }

  const trigger = typeof payload.trigger === 'string' ? payload.trigger : 'auto';
  const rawSessionId = payload.session_id;
  const sessionId = (typeof rawSessionId === 'string' && SESSION_ID_RE.test(rawSessionId))
    ? rawSessionId
    : 'unknown';

  let context = '';
  try {
    context = buildPreservationContext(trigger);
  } catch (e) {
    logHookError('hook-precompact:build', e);
    process.exit(0);
  }

  // PreCompact nu poate injecta context (stdout ignorat, additionalContext
  // nesuportat — vezi header). Scriem flag-ul; hook-user-prompt.js il consuma
  // la primul prompt de dupa compactare si injecteaza blocul acolo.
  if (context && sessionId !== 'unknown') {
    try {
      // atomicWrite: hook-user-prompt reads this flag on the next prompt; a torn
      // read would lose the compact-recovery context (sibling of AUD-P1-15).
      atomicWrite(
        join(SESSION_STATE_DIR, `${sessionId}-precompact.json`),
        JSON.stringify({ ts: Date.now(), session_id: sessionId, trigger, context }, null, 2)
      );
    } catch (e) {
      logHookError('hook-precompact:write-flag', e);
    }
  }
  process.exit(0);
}

// Direct-run guard — acelasi contract ca in hook-user-prompt.js si
// checkpoint-reminder.js: hook-ul ruleaza doar invocat direct (asa il porneste
// Claude Code, exec form), iar smoke-precompact.js poate importa
// resolveMemoryFile fara sa declanseze fluxul real (stdin, scriere de flag).
const __invokedFile = process.argv[1] && process.argv[1].replace(/\\/g, '/');
const __thisFile = fileURLToPath(import.meta.url).replace(/\\/g, '/');
if (__invokedFile === __thisFile) {
  main().catch((e) => {
    logHookError('hook-precompact', e);
    process.exit(0);
  });
}
