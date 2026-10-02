# sys-checkpoint („save state”) pentru robOS

Skill-ul de checkpoint înainte de `/compact`, împreună cu codul de care depinde. Scrie în
memoria zilei ce hook-ul PreCompact nu poate citi din conversație (decizii, teste, fapte
literale, blocaje), iar după compactare blocul `### Checkpoint` ajunge înapoi în context prin
`[COMPACT PRESERVATION]`.

Sursa: robOS 3.33.0 de pe laptop, commit `2a72541` (2026-10-02).

## Ce conține

Căile sunt cele din rădăcina robOS, deci folderele se copiază direct peste ea.

| Fișier | Rol |
|---|---|
| `skills/sys-checkpoint/SKILL.md` | skill-ul (v1.1.1) |
| `scripts/hook-precompact.js` | hook-ul `PreCompact`: salvează starea și ultimul bloc `### Checkpoint` (maximum 2000 de caractere); după miezul nopții citește din fișierul de ieri |
| `scripts/lib/memory-format.js` | `extractOpenThreads`, `extractLastCheckpoint` |
| `scripts/checkpoint-reminder.js` | reminderul de checkpoint, trimite la skill |
| `scripts/smoke-precompact.js` | test (36 de verificări) |
| `scripts/smoke-checkpoint-reminder.js` | test (27 de verificări) |
| `patches/robos-3.33.0-checkpoint.patch` | aceleași modificări ca patch, pentru robOS mai nou decât 3.33.0 |

Față de versiunea livrată de robOS 3.27.0, aici sunt incluse trei modificări locale: blocul de
checkpoint reinjectat după compactare, starea păstrată când sesiunea trece de miezul nopții și
corectura din Step 2 a skill-ului.

## Ce trebuie să existe deja pe robOS-ul țintă

- robOS 3.27.0 sau mai nou. Fișierele importă module de bază care trebuie să fie deja acolo:
  `scripts/lib/env-loader.js`, `hook-error-sink.js`, `client-context.js`, `read-stdin.js`,
  `atomic-write.js`, `smoke-hook-sink.js`, plus `scripts/brain-ingest-reminder.js` (funcția
  `evaluateClose`) și `scripts/hook-user-prompt.js`.
- În `.claude/settings.json`: `hook-precompact.js` înregistrat pe `PreCompact` (matcherele
  `manual` și `auto`) și `checkpoint-reminder.js` înregistrat pe `Stop`. Pe laptop (3.33.0) sunt
  acolo; pe alte versiuni le verifică pasul 5.

## Instalare

Din rădăcina robOS-ului țintă (Git Bash sau Linux):

```bash
# 1. copie de siguranță a versiunilor existente
mkdir -p .scratch/backup-sys-checkpoint
for f in skills/sys-checkpoint/SKILL.md scripts/hook-precompact.js scripts/lib/memory-format.js \
         scripts/checkpoint-reminder.js scripts/smoke-precompact.js scripts/smoke-checkpoint-reminder.js; do
  [ -f "$f" ] && mkdir -p ".scratch/backup-sys-checkpoint/$(dirname "$f")" && cp "$f" ".scratch/backup-sys-checkpoint/$f"
done

# 2. aduce repo-ul și versiunea robOS-ului țintă
git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
cat VERSION
```

Pasul 3 depinde de versiune.

**Varianta A: robOS 3.27.0 – 3.33.0.** Fișierele se copiază întregi peste rădăcină:

```bash
cp -r .scratch/sys-checkpoint-src/skills .scratch/sys-checkpoint-src/scripts .
```

**Varianta B: robOS mai nou decât 3.33.0** (de exemplu serverul, pe 3.40.2). Nu copia scripturile
întregi: ar înlocui codul nou al hook-urilor cu cel din 3.33.0 și ai pierde, fără să vezi, ce a
schimbat robOS între timp. Copiezi doar fișierele care lipsesc acolo și aplici modificările ca
patch:

```bash
mkdir -p skills/sys-checkpoint
cp .scratch/sys-checkpoint-src/skills/sys-checkpoint/SKILL.md skills/sys-checkpoint/
cp .scratch/sys-checkpoint-src/scripts/smoke-checkpoint-reminder.js scripts/
git apply --check .scratch/sys-checkpoint-src/patches/robos-3.33.0-checkpoint.patch \
  && git apply .scratch/sys-checkpoint-src/patches/robos-3.33.0-checkpoint.patch
```

Patch-ul conține tot ce s-a schimbat local în `hook-precompact.js`, `lib/memory-format.js`,
`checkpoint-reminder.js` și `smoke-precompact.js` față de robOS 3.33.0. Testat: aplicat pe
fișierele din 3.33.0, dă exact codul din repo. Netestat pe 3.40.2. Dacă `git apply --check` refuză,
fișierele s-au schimbat prea mult între versiuni. Atunci nu forțezi: modificările se integrează de
mână, cu patch-ul ca ghid.

```bash
# 4. reindexează skill-urile (triggerele noi intră în router)
node scripts/rebuild-index.js

# 5. verifică
node scripts/smoke-precompact.js
node scripts/smoke-checkpoint-reminder.js
grep -n "hook-precompact\|checkpoint-reminder" .claude/settings.json
```

Ambele teste trebuie să se termine cu `GREEN`. Dacă un test pică pe un import, robOS-ul țintă e
mai vechi decât modulul cerut: se actualizează robOS-ul întâi, nu se copiază module izolate.
Dacă `grep` nu găsește unul dintre hook-uri, înregistrarea lui lipsește din `.claude/settings.json`
și trebuie adăugată (`PreCompact` cu matcherele `manual` și `auto`, respectiv `Stop`).

Sesiunile Claude Code deschise înainte de instalare se repornesc, ca hook-urile să ruleze codul
nou.

## După un update de robOS

`scripts/update.js` suprascrie `scripts/` și `skills/` cu versiunea livrată, deci poate șterge
aceste modificări. După update se reiau pașii 2–5 pe varianta B (`git pull` în
`.scratch/sys-checkpoint-src` în loc de `git clone`).

## Dezactivare

`ROBOS_PRECOMPACT_DISABLED=1` în `.env` oprește partea automată (hook-ul). Skill-ul rămâne
utilizabil manual, iar linia-pointer din `### Open Threads` trimite tot la fișierul zilei.
