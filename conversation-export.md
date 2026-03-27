# SectorLISP / SICP Triple Store — Conversation Export

---

## Q1: uLisp SPO Triple Store with Microshaft Database

**User:** Show me how to use the ulisp query example (described here: http://www.ulisp.com/show?2I60) to build and query a Subject Predicate Object triple store. Use as an example the data base described in the SICP section 4.4 microshaft database example. Note that the ulisp examples work unchanged in Clisp Common Lisp.

**Assistant:** *(Fetched uLisp query engine source and SICP §4.4.1 Microshaft database, then produced `microshaft-spo.lisp`.)*

The query engine stores facts as arbitrary lists in `*db*`. Each fact is a `(triple SUBJECT PREDICATE OBJECT)`. Query variables are symbols starting with `?`. Combinators: `(and ...)`, `(or ...)`, `(not ...)`, `(test <lisp-expr>)`.

Key functions:
- `(query PATTERN BINDS)` → list of binding alists
- `(answer PATTERN OUTPUT)` → print each result via OUTPUT template

**Architecture:**
- `match` — unifies pattern with datum, extending a binding alist or returning `:fail`
- `subs` — substitutes variable bindings into a template
- `query` — dispatches on `and`/`or`/`not`/`test` or falls through to `query-simple`
- `query-simple` — scans `*db*` for pattern matches
- `query-and` — threads binding-sets through conjuncts (implements joins)

**Example queries produced:**
```lisp
; Q1 — simple lookup
(query '(triple ?person job (computer programmer)) nil)

; Q5 — 2-triple join
(query '(and (triple ?person supervisor bitdiddle-ben)
             (triple ?person salary ?s)) nil)

; Q6 — 3-triple join + test
(query '(and (triple ?person supervisor ?boss)
             (triple ?person salary ?ps)
             (triple ?boss salary ?bs)
             (test (< ?ps ?bs))) nil)
```

All 13 queries verified under CLISP.

---

## Q2: Translate to SectorLISP (Friendly Branch)

**User:** Now I would like to see if you can translate this to a much simpler Lisp, specifically a version of Justin Tunney's sectorlisp, the 'friendly' version that include DEFINE and is described in https://justine.lol/sectorlisp2/ - Read that page carefully. There are lots of details.

**Assistant:** *(Read the full lisp.js source from justine.lol, identified all constraints, produced `microshaft-spo-sectorlisp.lisp`, verified through a faithful Node.js reimplementation of the evaluator.)*

**Key translation decisions:**

1. **No comment syntax** — `;` is a valid atom character in SectorLISP. Used `(DEFINE COMMENT . (QUOTE ...))` instead.

2. **Query variables must be `(? NAME)` lists** — SectorLISP has no character inspection primitives. `?person` becomes `(? PERSON)`, detectable with just `ATOM` and `EQ`:
   ```lisp
   (DEFINE VARIABLEP . (LAMBDA (X)
     (COND ((ATOM X) NIL)
           ((EQ (CAR X) (QUOTE ?)) T)
           (T NIL))))
   ```

3. **Database inside a lambda body** — `DEFINE` stores values raw (unevaluated). `(DEFINE DB . (QUOTE (...)))` would store the *QUOTE form itself*, not the list. Solution: embed the database inside the `ANSWER` lambda body as a `QUOTE` literal, evaluated at call time.

4. **No GC after DEFINE** — The main loop must not call `Gc` after a `Define`. The freshly `Compact`ed alist cells live below the saved `A` pointer; calling `Gc(A, 0)` would discard them.

5. **Everything uppercase**, only 7 builtins: `QUOTE`, `COND`, `ATOM`, `CAR`, `CDR`, `CONS`, `EQ`.

All 10 queries verified through the SectorLISP JS evaluator.

---

## Q3: Split into Three Files

**User:** Split the demo into three files: The first file loads all the needed functions. The second file loads the database. The third file is the queries. Keep the comments.

**Assistant:** *(Produced three files, all verified running in sequence.)*

**`spo-functions.lisp`** — The complete query engine: `T`, `APPEND`, `EQUAL`, `VARIABLEP`, `LOOKUP`, `MATCH`, `SUBS`, `MAP-SUBS`, `QUERY-SIMPLE`, `MAPQUERY`, `QUERY-AND`, `QUERY-OR`, `QUERY-NOT`, `QUERY`, `ANSWER`.

**`microshaft-db.lisp`** — The database as a zero-arg lambda:
```lisp
(DEFINE MICROSHAFT-DB . (LAMBDA ()
  (QUOTE (
    (TRIPLE BITDIDDLE-BEN JOB (COMPUTER WIZARD))
    ...
  ))))
```

**`microshaft-queries.lisp`** — Ten queries, each calling `ANSWER` with three arguments:
```lisp
(ANSWER
  (QUOTE (TRIPLE (? P) JOB (COMPUTER PROGRAMMER)))
  (QUOTE (? P))
  (MICROSHAFT-DB))
```

**Why `MICROSHAFT-DB` is a zero-arg lambda:** `DEFINE` stores values raw. Storing `(QUOTE (facts...))` directly would leave the `QUOTE` form as the value. Wrapping in `(LAMBDA () (QUOTE (...)))` defers evaluation to call time, so `(MICROSHAFT-DB)` returns the live list of triples.

`ANSWER` takes three arguments `(EXPR TMPL DB)`, making the engine reusable with any database.

---

## Q4 & Q5: Web Page Playground

**User:** Make for me a web page .html that uses Justine Tunney's friendly lisp.js to make a web page that works just like the 'Simulation' section of https://justine.lol/sectorlisp2/

**User (follow-up):** I don't need terminal aesthetics

**Assistant:** *(Produced `sectorlisp-playground.html` — a single self-contained HTML file.)*

**Features:**
- **Eval** — runs editor contents; DEFINEs accumulate in the session alist
- **Trace** — toggles `Funtrace` mode (button highlights when active)
- **Load** — dropdown of 8 example programs in 3 groups (getting started, data structures, advanced) plus the full Microshaft SPO triple store
- **Share** — base64-encodes editor contents into the URL fragment; page restores on reload
- **Reset** — clears entire session (alist, heap, atom table)
- **Stats bar** — all 8 counters: `get`, `set`, `code`, `heap`, `atom`, `ms`, `read`, `print`

**Two critical engine details:**
- `DEFINE` never calls `Gc` — alist cons cells live below `A` and would be clobbered
- `Apply`'s final case dispatches through `lispFuncall` so trace mode works without touching the core evaluator

**Design:** Clean, minimal — white surface, `DM Sans` + `JetBrains Mono`, subtle borders, no terminal chrome.

---

## Q6: Commented Copy of lisp.js

**User:** Make me a commented copy of lisp.js with comments for each variable explaining its purpose and comments above each function explaining its purpose and how it works.

**Assistant:** *(Produced `lisp-commented.js`, 1,417 lines. Fetched the complete lisp.js source from justine.lol.)*

**Major sections documented:**

**Memory model** — The single array `M[Null*2]` is the entire machine. `Null = 16384` is the pivot. `M[Null + i]` for `i >= 0` is the atom table; for `i < 0` is the cons heap. Sign encodes type: positive = atom, negative = cons, zero = NIL. The `1./x < 0` trick exploits IEEE 754 signed zero.

**Global variables** — Every variable documented: `ax` (hash accumulator), `cx` (cons stack pointer), `dx` (one-char lookahead), `depth`/`panic`/`fail` (trace/debug), `cHeap`/`cGets`/`cSets`/`cReads`/`cPrints` (performance counters), `kEq`/`kCar` etc. (interned builtin addresses).

**Atom interning** — `Hash` magic numbers chosen so NIL→slot 0 and T→slot 1. `Intern` is open-addressed with quadratic probing. Each atom is a linked chain of single-character slots.

**ABC Garbage Collector** — Three positions A (before eval), B (after eval), C (after copying result). `Copy` recursively reproduces the result in fresh space; the slide loop moves it to just below A; `cx` is reset. 40 bytes of assembly.

**Evaluator** — Five cases in `Eval`: NIL, atom (variable lookup), QUOTE, COND, application. `Peel` optimisation prevents alist bloat in recursive functions. `Crunch`/`Compact` deduplicate the DEFINE alist.

**Polyglot structure** — Backtick template literals swallow C-only sections from JS; `#if 0...#endif` hides JS-only sections from C; `#define var int` and `#define function` make shared declarations compile in both.

---

## Q7: ANSWER as a QUERY Call

**User:** How would I make this `(ANSWER (QUOTE ...) (QUOTE ...) (MICROSHAFT-DB))` as a call to QUERY rather than to ANSWER?

**Assistant:** `ANSWER` is defined as:
```lisp
(DEFINE ANSWER . (LAMBDA (EXPR TMPL DB)
  (MAP-SUBS (QUERY EXPR NIL DB) TMPL)))
```

Inlining it:
```lisp
(MAP-SUBS
  (QUERY (QUOTE (TRIPLE (? P) JOB (COMPUTER PROGRAMMER)))
         NIL
         (MICROSHAFT-DB))
  (QUOTE (? P)))
```

To see raw binding alists before the template is applied, drop `MAP-SUBS`:
```lisp
(QUERY (QUOTE (TRIPLE (? P) JOB (COMPUTER PROGRAMMER)))
       NIL
       (MICROSHAFT-DB))
```
Returns `((((? P) . HACKER-ALYSSA)) (((? P) . FECT-CY)))`.

---

## Q8: Trace (QUOTE A)

**User:** Trace the execution of (QUOTE A)

**Assistant:**

**Phase 1 — Read:**

`Read()` calls `ReadAtom()`, which consumes `(`. Seeing the first char is `(`, delegates to `ReadList()`.

`ReadList()` calls `Read()` three times:
1. Reads atom `QUOTE` → returns `kQuote`
2. Reads atom `A` → returns `addr_A`
3. Reads `)` → returns `-0` (empty list)

Conses bottom-up:
```
Cons(addr_A, -0)     →  cell_2  =  (A)
Cons(kQuote, cell_2) →  cell_1  =  (QUOTE A)
```

Memory:
```
cell_1 → [ car: kQuote | cdr: cell_2 ]
cell_2 → [ car: addr_A | cdr: -0     ]
```

**Phase 2 — Eval:**

`Eval(cell_1, a)` tests five cases:
1. `!e` → skip (non-zero)
2. `e > 0` → skip (negative cons)
3. `Car(e) == kQuote` → **match** ✓

Returns `Car(Cdr(e)) = Car(cell_2) = addr_A`.

No environment lookup, no recursion, no allocation. `QUOTE` short-circuits before `Evlis` is ever called.

---

## Q9: Does it print A?

**User:** It does print A, yes?

**Assistant:** Yes. After `Eval` returns `addr_A`, the main loop calls `Print(addr_A)`.

`Print` checks `1./addr_A < 0` — positive → calls `PrintAtom(addr_A)`.

`PrintAtom` walks the character chain:
```
PrintChar(Get(addr_A))        → prints 'A'
x = Get(addr_A + Null/2)      → 0  (one-character atom, no continuation)
loop ends
```

`A` is printed, followed by a newline.

---

## Q10: Table of Contents (first)

**User:** Make a table of contents of the questions I've asked in this conversation

*(Listed questions 1–10.)*

---

## Q11: Instrumented Playground

**User:** Please create an instrumented copy of sectorlisp-playground.html that displays the name and value of each of the performance parameters on the JavaScript console each time it increments it. Do it with as little disruption as possible and elegantly.

**Assistant:** *(Produced `sectorlisp-instrumented.html`. The entire change is a 14-line IIFE inserted immediately before `Reset()`.)*

```js
(function () {
  var wrap = function (fn, label, val) {
    return function () {
      var r = fn.apply(this, arguments);
      console.log(label, '=', val());
      return r;
    };
  };
  Get   = wrap(Get,   'cGets',   function () { return cGets;   });
  Set   = wrap(Set,   'cSets',   function () { return cSets;   });
  Read  = wrap(Read,  'cReads',  function () { return cReads;  });
  Print = wrap(Print, 'cPrints', function () { return cPrints; });
}());
```

`wrap` takes a function, a label string, and a zero-argument accessor for the counter value. Returns a new function that calls the original and logs the post-increment value. Only the four sites where counters actually increment are wrapped; all other code is untouched.

---

## Q12: Arguments in Console Messages

**User:** Have the four functions also put their arguments in the console message

**Assistant:** One line added inside `wrap`:

```js
var args = Array.prototype.slice.call(arguments);
```

```js
var wrap = function (fn, label, val) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var r = fn.apply(this, arguments);
    console.log(label, '=', val(), '  args:', args);
    return r;
  };
};
```

`arguments` is captured before `fn.apply` so it reflects what the wrapper received. `Array.prototype.slice.call` converts the `Arguments` object to a plain array for clean console display.

---

## Q13: Hex Numbers in Console

**User:** Print the numbers in hex in the console

**Assistant:** One `hex` helper added at the top of the IIFE:

```js
var hex = function (n) {
  return typeof n === 'number' ? '0x' + (n >>> 0).toString(16) : n;
};
```

`n >>> 0` coerces to 32-bit unsigned before hex conversion, so negative cons cell addresses appear as their two's-complement representation (e.g. `-4` → `0xfffffffc`), matching the i8086 assembly's memory model.

Applied to both the counter value and all arguments:
```js
var args = Array.prototype.slice.call(arguments).map(hex);
console.log(label, '=', hex(val()), '  args:', args);
```

---

## Q14: DumpM — Display M Before First Eval

**User:** Create a procedure that will display the modified contents of M, interpreted. Display it immediately before the first call to eval.

**Assistant:** *(Added `DumpM` and a one-shot `Eval` wrapper inside the existing instrumentation IIFE. Captured a reference to unwrapped `Print` as `_Print` before wrapping.)*

```js
var _Print = Print;  // captured before Print gets wrapped

var atomName = function (slot) { /* walks char chain */ };
var lispStr  = function (x)    { /* renders via _Print without counter side-effects */ };

var DumpM = function () {
  // Atom table: all slots in [0, Null/2) with non-zero char field
  // Cons heap:  all allocated cells from cx up to -1
};

var _Eval = Eval;
Eval = function (e, a) {
  Eval = _Eval;   // restore immediately — before DumpM — so no recursion risk
  DumpM();
  return _Eval(e, a);
};
```

**`atomName(slot)`** — walks the continuation chain from any slot, reconstructing the name from that point. Mid-chain slots show partial names.

**`lispStr(x)`** — saves/restores `lispOut`, calls `_Print(x)`, returns the rendered string.

**One-shot wrapper** — `Eval = _Eval` fires before `DumpM`, so if anything inside rendering ever triggered `Eval` there would be no re-entry into the wrapper.

Sample output for `(QUOTE A)`:
```
── Atom table ────────────────────────────────
  0x0    'N'  cont->0x5d6   (continuation → "NIL")
  0x1    'T'  cont->0x0     "T"
  0x1a7b 'Q'  cont->0x1ae3  "QUOTE"
  0x11b4 'A'  cont->0x0     "A"
  ...

── Cons heap  [0xfffffffc .. 0xffffffff] ─────
  0xfffffffc  car=QUOTE (0x1a7b)  cdr=(A) (0xfffffffe)
  0xfffffffe  car=A (0x11b4)      cdr=() (0x0)
```

---

## Q15: Describe the Atom Interning Process

**User:** Describe the atom interning process

**Assistant:**

**What interning means:** Every distinct symbol name gets one unique integer address. `EQ` tests addresses, not strings.

**Storage layout:** The atom table occupies indices `0` through `Null/2 - 1`. Each slot `h` uses two cells:
```
M[Null + h]           → character code at this slot
M[Null + h + Null/2]  → address of the next character's slot (0 = end)
```
An atom is a **linked chain of single-character slots** scattered through the hash table. The atom's canonical address is the index of its first character's slot.

Chain for `QUOTE` (from the dump):
```
0x1a7b: 'Q'  cont->0x1ae3
0x1ae3: 'U'  cont->0x1a60
0x1a60: 'O'  cont->0x16be
0x16be: 'T'  cont->0x14b6
0x14b6: 'E'  cont->0x0
```
`kQuote = 0x1a7b`. EQ on two atoms is `0x1a7b == 0x1a7b`.

**ReadAtom reads right-to-left** via recursion. For `QUOTE`:
1. Reads `Q`, sees `U` — recurses; reads `U`, sees `O` — recurses... down to `E`
2. Base case: `Intern('E', 0, Hash('E',0), 1)` → creates/finds `slot_E`
3. Unwinds: `Intern('T', slot_E, ...)`, `Intern('O', slot_T, ...)`, ... `Intern('Q', slot_U, ...)`
4. `ax` accumulates a rolling hash across all characters

**Hash and magic numbers:**
```js
function Hash(h, x) {
  return (((h + x) * 3083 + 3191) >> 4) & (Null / 2 - 1);
}
```
Constants 3083 and 3191 found by exhaustive search so NIL → slot 0 and T → slot 1 (load-bearing: slot 0 is the BIOS load address = NULL).

**Intern — three cases:**
- **Found** — `(char, continuation)` pair matches → return `h`
- **Collision** — slot occupied by different atom → quadratic probe: `h' = (h + p²) & (Null/2 - 1)`
- **Empty** — write char and continuation, return `h`

**Suffix sharing:** From the `(QUOTE A)` dump, `0x1e7f` (`R`, cont→0) is shared by `CAR`, `CDR`, and the `AR` link inside `QUOTE`. First caller creates the slot; all subsequent callers find it.

---

## Q16: Did Justine Invent This?

**User:** Did Justine invent this or was this invented previously by someone else?

**Assistant:**

**Symbol interning as a concept — McCarthy, 1960–62.** The idea that every symbol name maps to one unique canonical address goes back to the beginning of Lisp. Early Lisp contained an *oblist* — a linked list of all interned symbols. Lookup was O(n) but the principle is identical.

**Hash-table interning — not Justine's either.** Using a hash table to speed up symbol lookup appears in every serious Lisp implementation from the 1970s onward (Emacs obarrays, MacLisp, etc.).

**The character-chain-in-a-flat-hash-table encoding — this appears to be Justine's.** Rather than storing full symbol strings as hash keys, each slot holds exactly one character and a pointer to the slot of the next character. This emerges from extreme constraints: the same 32 KB array must hold both atoms and cons cells, there is no separate string heap, and the implementation must fit in 436 bytes. The structure shares terminal suffixes automatically and never requires knowing an atom's length in advance. It is trie-like in spirit but threaded through a flat open-addressed hash table with no tree nodes.

**The magic-number hash function — definitely Justine's.** The constants 3083 and 3191 were found by a dedicated search program with a constraint no prior Lisp implementation ever needed: NIL must hash to slot 0 and T to slot 1, because the program image is loaded at the NULL address by the BIOS and those symbols must coincide with the boot sector's first bytes.

---

## Q17: TOM Before ATOM or ATOM Before TOM?

**User:** Does it make a difference to the resulting structure if 'TOM' is interned before 'ATOM' or the reverse?

**Assistant:** **No. The final structure is identical either way.**

`ReadAtom` recurses right-to-left. `Intern` is a pure function of its four arguments `(char, continuation, initial_slot, probe_step)`. Given the same `(char, continuation)` pair, the hash is the same, so the same table entry is found or created.

**ATOM first:** Creates slots for `M`, `O`, `T`, `A` (in bottom-up order of unwinding).

**TOM after:** Finds `M`, `O`, `T` already occupied and matching. Returns `slot_T` — the same slot that is the second link in `ATOM`'s chain. `TOM`'s address is `slot_T`.

**TOM first:** Creates `slot_M`, `slot_O`, `slot_T`. Then interning `ATOM` finds all three, adds only `slot_A`, links it to the pre-existing `slot_T`.

The atom table is **confluent**: any interning order produces the same set of occupied slots, the same addresses, and the same chain structure.

---

## Q18: Show M for (CDR (QUOTE (A B)))

**User:** Show me M for (CDR (QUOTE (A B))) right before calling eval

**Assistant:** *(Ran DumpM; full output follows.)*

**New atoms compared to (QUOTE A):**
```
0x1274  'B'  cont->0x0     "B"          (new)
0x1a94  'C'  cont->0x82d   "CDR"        (new first char; D→R tail shared with CAR)
```
`CDR` costs one new slot. `0x82d` (`D`) and `0x1e7f` (`R`) were already present from `LoadBuiltins`.

**Cons heap — 6 cells, cx = 0xfffffff4:**

```
addr        car                     cdr
──────────  ──────────────────────  ──────────────────────
0xfffffff4  CDR (0x1a94)            ((QUOTE (A B))) (0xfffffff6)
0xfffffff6  (QUOTE (A B)) (0xfff8)  () (0x0)
0xfffffff8  QUOTE (0x1a7b)          ((A B)) (0xfffffffa)
0xfffffffa  (A B) (0xfffffffc)      () (0x0)
0xfffffffc  A (0x11b4)              (B) (0xfffffffe)
0xfffffffe  B (0x1274)              () (0x0)
```

Three pairs of cells, three list levels:

- **`fc`/`fe`** — the list `(A B)` itself
- **`f8`/`fa`** — the list `(QUOTE (A B))`
- **`f4`/`f6`** — the outermost list `(CDR (QUOTE (A B)))`

Pointer diagram:
```
f4 → [ CDR   | f6 ]
f6 → [ f8    | () ]
f8 → [ QUOTE | fa ]
fa → [ fc    | () ]
fc → [ A     | fe ]
fe → [ B     | () ]
```

`Eval` sees `Car(f4) == kCdr`, calls `Evlis` on `Cdr(f4) = f6`, evaluates `(QUOTE (A B))` → `fc`, then `Apply` returns `Cdr(Car(x)) = Cdr(fc) = fe` = the list `(B)`.

Result: `(B)`

---

## Q19: List Questions Again

**User:** List my questions again

*(Questions 1–19 listed.)*

---

## Q20: Export This Conversation as Markdown

**User:** Export this entire conversation as markdown

*(This document.)*

---

*End of conversation export.*
