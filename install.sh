#!/usr/bin/env bash
# Installs the sys-checkpoint ("save state") skill and its hook changes into a robOS install.
#
# Run it from the robOS root (the folder with VERSION, scripts/ and skills/):
#   git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
#   bash .scratch/sys-checkpoint-src/install.sh
#
# Safe to run again (after a robOS update, or to check an install): it detects what is already there.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(pwd)"
PATCH="$SRC/patches/robos-3.33.0-checkpoint.patch"
MIN_VERSION="3.27.0"

say()  { printf '%s\n' "$*"; }
fail() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
# ver_ge A B: true when version A >= version B
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

# 1. Preconditions
[ -f "$ROOT/VERSION" ] && [ -d "$ROOT/scripts/lib" ] && [ -d "$ROOT/skills" ] && [ -f "$ROOT/.claude/settings.json" ] \
  || fail "Rulează scriptul din rădăcina robOS (folderul cu VERSION, scripts/ și skills/). / Run it from the robOS root folder."
[ "$SRC" != "$ROOT" ] || fail "Clonează repo-ul în .scratch/sys-checkpoint-src, nu direct în rădăcina robOS. / Clone the repo into .scratch/sys-checkpoint-src, not into the robOS root."
command -v node >/dev/null 2>&1 || fail "Lipsește node. / node is missing."
command -v git  >/dev/null 2>&1 || fail "Lipsește git (pe Windows rulează din Git Bash). / git is missing (on Windows, run from Git Bash)."

VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
ver_ge "$VERSION" "$MIN_VERSION" \
  || fail "robOS $VERSION e mai vechi decât $MIN_VERSION. Actualizează robOS întâi. / robOS $VERSION is older than $MIN_VERSION. Update robOS first."
say "robOS $VERSION"

# 2. Backup of every file this installer may change
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP=".scratch/backup-sys-checkpoint/$STAMP"
for f in skills/sys-checkpoint/SKILL.md scripts/hook-precompact.js scripts/lib/memory-format.js \
         scripts/checkpoint-reminder.js scripts/smoke-precompact.js scripts/smoke-checkpoint-reminder.js; do
  if [ -f "$ROOT/$f" ]; then
    mkdir -p "$ROOT/$BACKUP/$(dirname "$f")"
    cp "$ROOT/$f" "$ROOT/$BACKUP/$f"
  fi
done
say "Copie de siguranță / backup: $BACKUP"

# 3. Hook changes (state reinjected after compaction, midnight rollover)
cd "$ROOT"
if git apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  say "Hook-uri: modificările sunt deja prezente, nu schimb nimic. / Hooks: changes already present, nothing to do."
elif git apply --check "$PATCH" >/dev/null 2>&1; then
  git apply "$PATCH"
  say "Hook-uri: patch aplicat. / Hooks: patch applied."
elif ! ver_ge "$VERSION" "3.33.1"; then
  # robOS 3.27.0 - 3.33.0: the hook files from 3.33.0 replace the older ones whole.
  cp "$SRC/scripts/hook-precompact.js" "$SRC/scripts/checkpoint-reminder.js" "$SRC/scripts/smoke-precompact.js" scripts/
  cp "$SRC/scripts/lib/memory-format.js" scripts/lib/
  say "Hook-uri: fișiere copiate întregi (robOS <= 3.33.0). / Hooks: files copied whole (robOS <= 3.33.0)."
else
  fail "Patch-ul nu se aplică pe robOS $VERSION: fișierele hook-urilor s-au schimbat între timp. Nu am modificat nimic.
Cere-i robOS-ului tău să integreze de mână modificările din $PATCH, apoi rulează din nou acest script.
/ The patch does not apply to robOS $VERSION (hook files changed since). Nothing was modified.
Ask your robOS to merge the changes from the patch by hand, then run this script again."
fi

# 4. The skill itself
mkdir -p skills/sys-checkpoint
cp "$SRC/skills/sys-checkpoint/SKILL.md" skills/sys-checkpoint/SKILL.md
[ -f scripts/smoke-checkpoint-reminder.js ] || cp "$SRC/scripts/smoke-checkpoint-reminder.js" scripts/
say "Skill: skills/sys-checkpoint/SKILL.md instalat. / installed."

# 5. Re-index skills so the router knows the new triggers
node scripts/rebuild-index.js >/dev/null
say "Index de skill-uri regenerat. / Skill index rebuilt."

# 6. Hook registration in .claude/settings.json
MISSING=""
grep -q 'hook-precompact' .claude/settings.json     || MISSING="$MISSING PreCompact:hook-precompact.js"
grep -q 'checkpoint-reminder' .claude/settings.json || MISSING="$MISSING Stop:checkpoint-reminder.js"
if [ -n "$MISSING" ]; then
  say ""
  say "ATENȚIE / WARNING: lipsesc din .claude/settings.json înregistrările:$MISSING"
  say "Vezi secțiunea „Înregistrarea hook-urilor” din README. / See \"Hook registration\" in README.en.md."
  exit 2
fi

# 7. Tests
TESTS_OK=1
for t in smoke-precompact smoke-checkpoint-reminder; do
  if OUT="$(node "scripts/$t.js" 2>&1)"; then
    say "Test $t: $(printf '%s\n' "$OUT" | tail -n1)"
  else
    TESTS_OK=0
    say "Test $t A PICAT / FAILED:"
    printf '%s\n' "$OUT" | tail -n15
  fi
done
[ "$TESTS_OK" = 1 ] || fail "Un test a picat (vezi mai sus). Fișierele vechi sunt în $BACKUP. / A test failed. The old files are in $BACKUP."

say ""
say "GATA. Repornește sesiunile Claude Code deschise, apoi spune „save state” înainte de /compact."
say "DONE. Restart any open Claude Code sessions, then say \"save state\" before /compact."
