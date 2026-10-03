# sys-checkpoint („save state”) pentru robOS

**English:** [README.en.md](README.en.md)

Un skill pentru robOS care îți salvează sesiunea înainte de `/compact`, ca după compactare să nu
pierzi nimic important.

Autor: Răzvan Bordeanu.

## De ce ai nevoie de el

Când conversația cu Claude Code se umple, ea se compactează: tot ce s-a discutat devine un
rezumat. Rezumatul pierde tocmai ce e greu de refăcut:

- de ce ai ales varianta A și nu B;
- ce test a picat și cu ce mesaj;
- ID-ul, linkul sau calea exactă cu care ai lucrat;
- corecturile pe care i le-ai făcut lui Claude.

După compactare, Claude pornește cu un rezumat vag și trebuie să-i explici din nou.

Cu acest skill spui **„save state”** înainte de `/compact`. Claude scrie în memoria zilei
(`context/memory/AAAA-LL-ZZ.md`) un bloc `### Checkpoint` cu:

- deciziile luate și motivul lor;
- rezultatele testelor;
- sarcinile încă deschise;
- faptele exacte (ID-uri, linkuri, valori);
- ce te blochează.

După compactare, robOS pune singur blocul înapoi în context, iar sesiunea continuă de unde a
rămas. Skill-ul nu închide sesiunea.

## Cum îl folosești

Înainte de `/compact`, scrie una dintre frazele:

- `save state`
- `salvează starea` / `salvează starea sesiunii`
- `checkpoint`
- `înainte de compact` / `pregătește compactarea`
- `nu pierde contextul`

Claude parcurge sesiunea, scrie blocul și îți spune ce a salvat. Apoi dai `/compact`.

Două lucruri merg și fără să ceri:

- **Hook-ul `PreCompact`** salvează automat, la fiecare compactare (manuală sau automată), starea
  pe care o poate citi singur: clientul activ, calea memoriei zilei, firele deschise și ultimul bloc
  `### Checkpoint`. Le pune înapoi în context la primul mesaj de după compactare.
- **Reminderul de checkpoint** îți amintește, la finalul unui răspuns, când memoria zilei n-a mai
  fost actualizată de mult timp.

## Cerințe

- robOS **3.27.0 sau mai nou** (vezi fișierul `VERSION` din rădăcina robOS);
- `git` (pe Windows vine cu Git Bash, pe care Claude Code îl folosește oricum);
- `node` (vine cu robOS).

## Instalare rapidă: o face robOS-ul tău

Deschide robOS-ul (Claude Code în folderul robOS) și lipește mesajul de mai jos:

```text
Instalează skill-ul sys-checkpoint („save state”) din https://github.com/razvan-stack/robos-skill-sys-checkpoint.
Pași, din rădăcina robOS-ului meu:
1. Dacă .scratch/sys-checkpoint-src există, rulează în el `git pull`; altfel clonează repo-ul acolo:
   git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
2. Rulează `bash .scratch/sys-checkpoint-src/install.sh` și arată-mi tot ce afișează.
3. Dacă scriptul se oprește cu STOP sau iese cu codul 2, citește README.md din repo (secțiunile
   „Dacă instalarea se oprește” și „Înregistrarea hook-urilor”), repară cauza, apoi rulează din nou scriptul.
4. Nu șterge nimic și nu face commit. La final spune-mi ce s-a instalat și ce au arătat cele două teste.
```

La final, închide și redeschide sesiunile Claude Code, ca hook-urile să ruleze codul nou.

## Instalare manuală

Din rădăcina robOS (Git Bash pe Windows, terminal pe Mac sau Linux):

```bash
git clone https://github.com/razvan-stack/robos-skill-sys-checkpoint.git .scratch/sys-checkpoint-src
bash .scratch/sys-checkpoint-src/install.sh
```

Scriptul face singur următorii pași:

1. Verifică dacă rulează în rădăcina robOS și dacă versiunea e cel puțin 3.27.0.
2. Face o copie de siguranță a fișierelor pe care le poate schimba, în
   `.scratch/backup-sys-checkpoint/<data-ora>/`.
3. Aduce hook-urile la zi, după ce găsește:
   - **modificările sunt deja acolo** (de exemplu la a doua rulare): nu schimbă nimic;
   - **patch-ul se aplică**: îl aplică;
   - **robOS 3.27.0 – 3.33.0**: copiază fișierele hook-urilor întregi;
   - **altfel**: se oprește fără să modifice nimic (vezi mai jos).
4. Instalează skill-ul în `skills/sys-checkpoint/` și regenerează indexul de skill-uri, ca robOS
   să recunoască frazele de mai sus.
5. Verifică dacă hook-urile sunt înregistrate în `.claude/settings.json`.
6. Rulează cele două teste. Amândouă trebuie să se termine cu `GREEN`.

Instalarea e gata când scriptul afișează `GATA`. Repornește apoi sesiunile Claude Code deschise.

## Verificare

```bash
node scripts/smoke-precompact.js
node scripts/smoke-checkpoint-reminder.js
```

Ambele trebuie să afișeze `GREEN`. Apoi, într-o sesiune nouă, scrie `save state`: Claude trebuie
să scrie blocul `### Checkpoint` în memoria zilei.

## Dacă instalarea se oprește

| Mesaj | Ce faci |
|---|---|
| `Rulează scriptul din rădăcina robOS` | Intră în folderul robOS (cel cu `VERSION`) și rulează din nou. |
| `robOS ... e mai vechi decât 3.27.0` | Actualizează întâi robOS, apoi rulează din nou. |
| `Patch-ul nu se aplică pe robOS ...` | Fișierele hook-urilor s-au schimbat față de ce cunoaște patch-ul. Nu s-a modificat nimic. Cere-i robOS-ului tău să integreze de mână modificările din `patches/robos-3.33.0-checkpoint.patch`, apoi rulează din nou scriptul. |
| `lipsesc din .claude/settings.json înregistrările` | Adaugă înregistrarea (vezi secțiunea următoare) și rulează din nou. |
| `Un test a picat` | Mesajul testului e afișat deasupra. Fișierele dinainte sunt în `.scratch/backup-sys-checkpoint/`; copiază-le înapoi dacă vrei să revii. |

## Înregistrarea hook-urilor

De obicei robOS le are deja. Dacă scriptul spune că lipsesc, în `.claude/settings.json`,
sub `"hooks"`, trebuie să existe:

```json
"PreCompact": [
  { "matcher": "manual", "hooks": [ { "type": "command", "command": "node", "timeout": 5,
      "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-precompact.js"] } ] },
  { "matcher": "auto", "hooks": [ { "type": "command", "command": "node", "timeout": 5,
      "args": ["${CLAUDE_PROJECT_DIR}/scripts/hook-precompact.js"] } ] }
]
```

iar în lista `"Stop"` (adăugat lângă celelalte, nu în locul lor):

```json
{ "type": "command", "command": "node", "timeout": 5,
  "args": ["${CLAUDE_PROJECT_DIR}/scripts/checkpoint-reminder.js"] }
```

## După un update de robOS

Un update poate suprascrie fișierele din `scripts/` și `skills/`. După fiecare update rulezi din nou
instalarea (sau lipești din nou mesajul de la „Instalare rapidă”):

```bash
git -C .scratch/sys-checkpoint-src pull
bash .scratch/sys-checkpoint-src/install.sh
```

Scriptul vede ce e deja la zi și nu schimbă nimic inutil.

## Dezactivare

În `.env`-ul robOS:

- `ROBOS_PRECOMPACT_DISABLED=1` oprește salvarea automată la compactare;
- `ROBOS_CHECKPOINT_DISABLED=1` oprește reminderul.

Skill-ul rămâne utilizabil manual, cu „save state”.

## Ce conține repo-ul

Căile sunt cele din rădăcina robOS.

| Fișier | Rol |
|---|---|
| `install.sh` | instalarea automată, descrisă mai sus |
| `skills/sys-checkpoint/SKILL.md` | skill-ul (v1.1.1) |
| `scripts/hook-precompact.js` | hook-ul `PreCompact`: salvează starea și ultimul bloc `### Checkpoint` (maximum 2000 de caractere); după miezul nopții citește din fișierul de ieri |
| `scripts/lib/memory-format.js` | funcțiile care citesc firele deschise și ultimul checkpoint din memoria zilei |
| `scripts/checkpoint-reminder.js` | reminderul de checkpoint, care trimite la skill |
| `scripts/smoke-precompact.js` | test (36 de verificări) |
| `scripts/smoke-checkpoint-reminder.js` | test (27 de verificări) |
| `patches/robos-3.33.0-checkpoint.patch` | modificările hook-urilor, ca patch, pentru robOS mai nou decât 3.33.0 |

Fișierele din `scripts/` sunt versiunea din robOS 3.33.0, cu trei modificări: blocul de checkpoint
pus înapoi în context după compactare, starea păstrată când sesiunea trece de miezul nopții și o
corectură în pasul 2 al skill-ului.

## Ce a fost testat

Pe 3 octombrie 2026, `install.sh` a rulat pe o copie a robOS 3.40.17 în șase situații: hook-urile
deja modificate (instalează doar skill-ul), hook-urile fără modificări, ca la o instalare nouă (aplică patch-ul), a doua rulare
(nu schimbă nimic), versiune prea veche, hook neînregistrat și rulare din alt folder. Toate s-au
comportat ca mai sus, iar testele au ieșit `GREEN`. Patch-ul a fost verificat anterior pe fișierele
din robOS 3.33.0. Copierea fișierelor întregi pentru robOS 3.27.0 – 3.32.x n-a fost testată pe
acele versiuni.
