# sys-checkpoint ("save state") for robOS

**Română:** [README.md](README.md)

A robOS skill that saves your session before `/compact`, so nothing important is lost when the
conversation is compacted.

Author: Răzvan Bordeanu.

## Why you need it

When a Claude Code conversation fills up, it gets compacted: everything discussed becomes a
summary. The summary loses exactly what is hard to rebuild:

- why you chose option A over B;
- which test failed and with what message;
- the exact ID, link or path you were working with;
- the corrections you gave Claude.

After compaction, Claude starts from a vague summary and you have to explain things again.

With this skill you say **"save state"** before `/compact`. Claude writes a `### Checkpoint` block
into today's memory file (`context/memory/YYYY-MM-DD.md`) with:

- the decisions made and why;
- test results;
- tasks still open;
- exact facts (IDs, links, values);
- what is blocking you.

After compaction, robOS puts that block back into context on its own and the session continues
where it left off. The skill does not close the session.

## How to use it

Before `/compact`, type one of:

- `save state` / `save session state`
- `checkpoint`
- `before compact` / `prepare for compaction`
- `don't lose context`

Romanian phrases work too (`salvează starea`, `nu pierde contextul`). Claude goes through the
session, writes the block and tells you what it saved. Then run `/compact`.

Two things also work without asking:

- **The `PreCompact` hook** saves, on every compaction (manual or automatic), the state it can read
  by itself: active client, path of today's memory, open threads and the last `### Checkpoint`
  block. It puts them back into context on the first message after compaction.
- **The checkpoint reminder** nudges you at the end of a reply when today's memory has not been
  updated for a long time.

## Requirements

- robOS **3.27.0 or newer** (see the `VERSION` file in the robOS root);
- `git` (on Windows it comes with Git Bash, which Claude Code uses anyway);
- `node` (comes with robOS).

## Quick install: let your robOS do it

Open robOS (Claude Code in the robOS folder) and paste this message:

```text
Install the sys-checkpoint ("save state") skill from https://github.com/razvan-stack/robos-skill-sys-checkpoint.
Steps, from the root of my robOS:
1. If .scratch/sys-checkpoint-src exists, run `git pull` inside it; otherwise clone the repo there:
   git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
2. Run `bash .scratch/sys-checkpoint-src/install.sh` and show me everything it prints.
3. If the script stops with STOP or exits with code 2, read README.en.md in the repo (sections
   "If the install stops" and "Hook registration"), fix the cause, then run the script again.
4. Do not delete anything and do not commit. At the end, tell me what was installed and what the two tests showed.
```

When it is done, close and reopen your Claude Code sessions so the hooks run the new code.

## Manual install

From the robOS root (Git Bash on Windows, a terminal on Mac or Linux):

```bash
git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
bash .scratch/sys-checkpoint-src/install.sh
```

The script does the following by itself:

1. Checks that it runs in the robOS root and that the version is at least 3.27.0.
2. Backs up every file it may change into `.scratch/backup-sys-checkpoint/<date-time>/`.
3. Brings the hooks up to date, depending on what it finds:
   - **changes already present** (recent robOS): changes nothing;
   - **the patch applies**: applies it;
   - **robOS 3.27.0 – 3.33.0**: copies the hook files whole;
   - **otherwise**: stops without modifying anything (see below).
4. Installs the skill into `skills/sys-checkpoint/` and rebuilds the skill index, so robOS
   recognises the phrases above.
5. Checks that the hooks are registered in `.claude/settings.json`.
6. Runs the two tests. Both must end with `GREEN`.

The install is done when the script prints `DONE`. Then restart any open Claude Code sessions.

## Verify

```bash
node scripts/smoke-precompact.js
node scripts/smoke-checkpoint-reminder.js
```

Both must print `GREEN`. Then, in a new session, type `save state`: Claude should write the
`### Checkpoint` block into today's memory.

## If the install stops

| Message | What to do |
|---|---|
| `Run it from the robOS root folder` | Go to the robOS folder (the one with `VERSION`) and run it again. |
| `robOS ... is older than 3.27.0` | Update robOS first, then run it again. |
| `The patch does not apply to robOS ...` | The hook files changed compared with what the patch knows. Nothing was modified. Ask your robOS to merge the changes from `patches/robos-3.33.0-checkpoint.patch` by hand, then run the script again. |
| `WARNING: ... .claude/settings.json` | Add the registration (next section) and run it again. |
| `A test failed` | The test output is shown above. The previous files are in `.scratch/backup-sys-checkpoint/`; copy them back if you want to revert. |

## Hook registration

robOS usually has them already. If the script says they are missing, `.claude/settings.json` must
contain, under `"hooks"`:

```json
"PreCompact": [
  { "matcher": "manual", "hooks": [ { "type": "command", "command": "node", "timeout": 5,
      "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-precompact.js"] } ] },
  { "matcher": "auto", "hooks": [ { "type": "command", "command": "node", "timeout": 5,
      "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-precompact.js"] } ] }
]
```

and, in the `"Stop"` list (added next to the existing entries, not replacing them):

```json
{ "type": "command", "command": "node", "timeout": 5,
  "args": ["${CLAUDE_PROJECT_DIR}/scripts/checkpoint-reminder.js"] }
```

## After a robOS update

An update can overwrite the files in `scripts/` and `skills/`. After each update, run the install
again (or paste the quick-install message again):

```bash
git -C .scratch/sys-checkpoint-src pull
bash .scratch/sys-checkpoint-src/install.sh
```

The script sees what is already up to date and changes nothing it does not need to.

## Turning it off

In the robOS `.env`:

- `ROBOS_PRECOMPACT_DISABLED=1` turns off the automatic save on compaction;
- `ROBOS_CHECKPOINT_DISABLED=1` turns off the reminder.

The skill stays available manually with "save state".

## What the repo contains

Paths are relative to the robOS root.

| File | Role |
|---|---|
| `install.sh` | the automatic install described above |
| `skills/sys-checkpoint/SKILL.md` | the skill (v1.1.1) |
| `scripts/hook-precompact.js` | the `PreCompact` hook: saves the state and the last `### Checkpoint` block (2000 characters max); after midnight it reads yesterday's file |
| `scripts/lib/memory-format.js` | the functions that read open threads and the last checkpoint from today's memory |
| `scripts/checkpoint-reminder.js` | the checkpoint reminder, which points to the skill |
| `scripts/smoke-precompact.js` | test (36 checks) |
| `scripts/smoke-checkpoint-reminder.js` | test (27 checks) |
| `patches/robos-3.33.0-checkpoint.patch` | the hook changes as a patch, for robOS newer than 3.33.0 |

The files in `scripts/` are the robOS 3.33.0 versions with three changes: the checkpoint block put
back into context after compaction, state kept when a session runs past midnight, and a fix in
step 2 of the skill. The skill's own instructions (`SKILL.md`) are written in Romanian; Claude
follows them in any language.

## What was tested

On 3 October 2026, `install.sh` ran on a copy of robOS 3.40.17 in six situations: hooks already up
to date (installs only the skill), hooks without the changes (applies the patch), a second run
(changes nothing), a version that is too old, a missing hook registration, and running from the
wrong folder. All behaved as described above and the tests came out `GREEN`. The patch had earlier
been checked against the robOS 3.33.0 files. Copying whole files for robOS 3.27.0 – 3.32.x has not
been tested on those versions.
