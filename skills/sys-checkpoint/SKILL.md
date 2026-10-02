---
name: sys-checkpoint
version: 1.1.1
category: sys
description: "Checkpoint inainte de /compact. Scrie in memoria zilei exact ce hook-ul PreCompact NU poate citi din conversatie — decizii cu motivul lor, rezultate de teste, TODO-uri active, fapte literale, blocaje — ca sesiunea sa fie reluabila dupa compactare. Nu inchide sesiunea."
triggers:
  - "checkpoint"
  - "checkpoint pre-compact"
  - "salveaza starea"
  - "salveaza starea sesiunii"
  - "salveaza-mi starea"
  - "salveaza-mi contextul"
  - "salveaza contextul"
  - "inainte de compact"
  - "inainte sa compactez"
  - "pregateste compactarea"
  - "nu pierde contextul"
  - "save state"
  - "save session state"
  - "save the state"
  - "before compact"
  - "pre-compact"
  - "prepare for compaction"
  - "don't lose context"
negative_triggers:
  - "checkpoint git"
  - "checkpoint pe ramura"
  - "salveaza fisierul"
  - "salveaza nota"
  - "salveaza in brain"
  - "save the file"
  - "git checkpoint"
  # Meta-discutie DESPRE skill sau despre codul lui — nu o cerere de checkpoint.
  # Observate pe router (2026-09-22): „poti verifica skillul save state", „hai sa
  # reparam checkpoint-reminder.js", „pune un checkpoint in cod".
  - "verifica skillul"
  - "verifica skill-ul"
  - "auditeaza skillul"
  - "auditeaza skill-ul"
  - "audit al skillului"
  - "skillul de checkpoint"
  - "skill-ul de checkpoint"
  - "checkpoint-reminder"
  - "checkpoint in cod"
  - "audit the skill"
  - "check the skill"
output_discipline: minimal
context_loads:
  - context/memory/YYYY-MM-DD.md (writes)
inputs: []
outputs:
  - context/memory/YYYY-MM-DD.md actualizat (sectiunile sesiunii curente + bloc Checkpoint)
tier: core
---

# Ce face acest skill si de ce exista

Compactarea pastreaza un sumar al conversatiei. Sumarul pierde tocmai ce e greu de
reconstruit: de ce s-a ales varianta A in loc de B, ce test a picat si cu ce mesaj,
ce ID sau URL exact s-a folosit, ce corectie a facut operatorul.

O parte din stare se salveaza deja **determinist**, fara mine:
[scripts/hook-precompact.js](../../scripts/hook-precompact.js) ruleaza pe evenimentul
`PreCompact` (ambele matchere, `manual` si `auto`) si captureaza branch-ul git,
fisierele necomise, calea memoriei zilei, clientul activ, firele deschise **deja
scrise in fisier** si **ultimul bloc `### Checkpoint`** (plafonat la 2000 de caractere).
Le rescrie in context la primul prompt de dupa compactare, ca bloc `[COMPACT PRESERVATION]`.
Cand sesiunea trece de miezul noptii si fisierul zilei noi inca nu exista, citeste din
fisierul de ieri daca a fost atins in ultimele 6 ore, si o spune in bloc; scrierile tale
merg tot pe fisierul zilei curente.

Pana pe 2026-09-22 blocul de checkpoint NU era injectat, si masuratoarea a aratat de ce
conteaza: pe trei compactari reale, nicio reluare nu a deschis fisierul zilei ca sa-l
citeasca. Ce scria skill-ul la categoriile 5-7 ajungea in context doar daca faptele
supravietuisera intamplator in sumarul compactarii (18 din 22 de linii, o singura
masuratoare — indiciu, nu garantie).

Ce hook-ul NU poate face: sa citeasca conversatia. Si inca ceva, mai subtil —
`extractOpenThreads` **extrage** firele din fisier, nu le inventeaza. Daca nimeni
nu le-a scris, hook-ul salveaza o lista goala si pare ca totul e in regula.

Acest skill acopera fix diferenta.

**NU inchide sesiunea.** Daca operatorul vrea inchidere completa (feedback, 2brain,
commit), ala e `sys-session-close`. Aici doar se salveaza starea si se continua.

---

# Step 0: Nu delega. Verifica destinatia.

**Nu invoca Agent / sub-agent pentru acest skill.** Un sub-agent nu vede conversatia,
adica exact materialul pe care il salvam. Delegarea ar produce un checkpoint gol care
arata plin. Tot ce urmeaza se executa in main thread.

**Verifica unde scrii.** Memoria merge la SUBIECTUL muncii, nu automat la clientul
activ (CLAUDE.md § Memory Routing). Daca sesiunea a fost despre altceva decat clientul
activ — munca personala, alt client — scrie pe calea absoluta a workspace-ului corect.
La indoiala, `node scripts/active-client.js status` spune doar cine e activ, nu unde
trebuie sa scrii; decizia e a ta.

Citeste fisierul zilei inainte sa scrii in el. Fara Read prealabil nu editezi (Core
Principles).

**Verifica daca sectiunea ta mai e ultima.** Fisierul zilei e partajat intre toate
tab-urile deschise (2026-09-22: sapte sesiuni intr-o zi, cu suprapuneri). Daca alt tab
a deschis intre timp un `## Session` mai jos decat al tau, `extractOpenThreads` va citi
sectiunea LUI, iar firele tale devin invizibile pentru hook — exact esecul pe care
skill-ul asta il previne, venit din alta directie.

```bash
grep -n "^## Session" context/memory/$(date +%F).md | tail -3
```

Daca sectiunea ta nu mai e ultima: scrie firele TALE si in ultima sectiune a fisierului,
fiecare prefixat cu sesiunea din care vine (`[S5] ...`), pe langa sectiunea ta. Duplicarea
e ieftina; un fir invizibil nu.

**Daca nu exista fisier de zi sau sectiune de sesiune**, il creezi cu structura standard
(`## Session N` -> `### Goal` / `### Deliverables` / `### Decisions` / `### Open Threads`)
si continui normal. Un checkpoint fara sectiune-gazda nu se abandoneaza.

---

# Step 1: Parcurge sesiunea integral

De la primul mesaj pana la cel curent, **fara esantion**. „Am prins ideea" din ultimele
schimburi rateaza fix deciziile luate la inceput, care sunt cele mai greu de reconstruit
mai tarziu.

Extrage pe cele sapte categorii de mai jos. Ce nu apare in sesiune se noteaza
„nu apare in sesiune" — nu se completeaza din presupunere.

1. **Goal** — ce a urmarit operatorul, in cuvintele lui din prompturi, nu in parafraza ta.
2. **Deliverables** — fiecare fisier creat, modificat sau publicat, cu calea lui si ce
   s-a schimbat in el; comenzile cu efect real; ce s-a trimis sau deployat.
3. **Decisions** — fiecare alegere **si motivul ei**, inclusiv alternativele respinse.
   Include corectiile primite de la operator si regula rezultata (Mistake → Rule).
4. **Open Threads** — tot ce e neterminat, fiecare cu **urmatorul pas concret** (comanda
   sau fisierul de la care se reia), plus TODO-urile din TodoWrite care nu sunt `completed`.
5. **Fapte literale** — ce nu se poate reconstrui din memorie: ID-uri, URL-uri, cai,
   cifre, versiuni, selectori, nume de chei (**numele**, niciodata valoarea), fragmente
   de cod la care s-a facut referire. Copiate exact, nu reformulate.
6. **Verificari** — ce smoke sau test a rulat si rezultatul exact (pass/fail, ce a picat
   si cu ce mesaj). Ce n-a fost testat se scrie explicit „netestat".
7. **Blocaje** — ce asteapta raspuns de la operator si ce presupuneri neverificate stau
   sub munca de pana acum.

---

# Step 2: Scrie in memoria zilei

Primele patru categorii merg in sectiunile **existente** ale sesiunii curente. Nu deschizi
o a doua sectiune `## Session N` pentru o sesiune care are deja una, si nu creezi o a doua
sectiune `### Open Threads` in ea. (Cazul in care fisierul zilei sau sectiunea lipsesc cu
totul — sesiune noua, zi noua — e tratat la Step 0: acolo chiar le creezi.)

> **Capcana, verificata in cod:** `extractOpenThreads`
> ([scripts/lib/memory-format.js](../../scripts/lib/memory-format.js)) citeste **ultima**
> sectiune `### Open Threads` din fisier. O sectiune noua adaugata mai jos face invizibile
> firele de mai sus — hook-ul le va raporta ca inexistente. Scrii in sectiunea sesiunii
> curente, DUPA ce ai verificat la Step 0 ca ea chiar mai e ultima: pe tab-uri paralele
> poate sa nu mai fie, si atunci firele tale merg si in ultima sectiune, prefixate cu
> sesiunea din care vin.

Categoriile 5-7 nu au sectiune canonica, deci merg intr-un bloc propriu, adaugat
**dupa** `### Open Threads` al sesiunii curente:

```markdown
### Checkpoint HH:MM

**Fapte literale**
- {id / url / cale / cifra / nume-cheie, exact}

**Verificari**
- {comanda}: {pass | fail — ce a picat} | netestat

**Blocaje**
- {intrebare deschisa catre operator / presupunere neverificata}

**Reluare:** {primul lucru de facut dupa compact}
```

**Pune si linia-pointer in `### Open Threads`.** Ultima linie pe care o adaugi la firele
deschise, la fiecare checkpoint:

```markdown
- Checkpoint {HH:MM} scris in acest fisier (fapte literale, verificari, blocaje) — citeste-l inainte sa continui.
```

De ce: blocul de checkpoint e injectat inapoi dupa compactare de `hook-precompact.js`
(ultimul bloc, plafonat la 2000 de caractere), dar Open Threads e canalul cu text
integral si fara plafon. Pointerul acopera cazul in care blocul a fost trunchiat sau
hook-ul e oprit (`ROBOS_PRECOMPACT_DISABLED=1`) — atunci fisierul ramane singura cale, si
cineva trebuie sa spuna ca merita deschis. Masurat pe trei compactari reale inainte de
fix: zero reluari au deschis fisierul din proprie initiativa.

Reguli de scriere:

- **Adaugi, nu suprascrii.** Nimic din continutul existent nu se sterge.
- **Comprimi ce s-a rezolvat.** La checkpointul N+1, un fapt deja rezolvat sau o verificare
  deja depasita NU se recita: ramane in blocul vechi, care e istoricul. Blocul nou poarta
  doar delta de la ultimul checkpoint. (Fara regula asta blocurile cresc monoton — masurat
  pe 2026-09-22: 2038 -> 3293 -> 4659 -> 6203 octeti, 40% din fisierul zilei — iar hook-ul
  injecteaza doar ultimul bloc, deci un bloc umflat isi pierde tocmai partea noua la plafon.)
- **Nu rezuma la nivel de titlu.** Un fir fara pasul urmator e un fir pierdut.
- **Token-urile `Goal` / `Deliverables` / `Decisions` / `Open Threads` / `Session` raman
  in engleza** — sunt contracte regex citite de hook-uri, cron si lint, nu titluri de afisat.
- La al doilea checkpoint in aceeasi sesiune, adaugi un bloc `### Checkpoint HH:MM` nou;
  nu il rescrii pe cel vechi. Firele deschise se actualizeaza in loc, in sectiunea lor.

---

# Step 3: Raporteaza si opreste-te

Output **exact** trei linii, nimic in plus:

```
Checkpoint scris: {cale relativa a fisierului zilei}
Fire deschise: {N} | Fapte literale: {N} | Verificari: {N pass, N fail, N netestate}
Reluare: {primul lucru de facut dupa compact}
```

Apoi **stop**. Nu compactezi tu, nu propui alt pas, nu continui munca. Operatorul
ruleaza `/compact` cand vrea.

Daca la Step 1 nu ai gasit nimic de salvat (sesiune pur conversationala), spui o singura
linie — „Nimic de salvat: sesiunea n-a produs stare durabila." — si nu scrii in fisier.
Tacerea ar arata identic cu o omisiune.

---

# Dupa compactare (pentru operator)

O linie de control merita: „confirma ca ai blocul COMPACT PRESERVATION si spune-mi de
unde reluam". Daca blocul lipseste, hook-ul a picat si raspunsul e in
`data/hook-errors.ndjson`.

Blocul injectat contine acum si ultimul `### Checkpoint`, dar **plafonat la 2000 de
caractere**. Daca vezi in el linia `... (trunchiat ...)`, restul e in fisierul zilei si se
citeste de acolo — motiv in plus pentru regula de comprimare de la Step 2: blocul scurt
trece intreg, blocul umflat isi pierde coada.

Toggle care dezactiveaza partea automata: `ROBOS_PRECOMPACT_DISABLED=1`.
Guard: `node scripts/smoke-precompact.js`.
