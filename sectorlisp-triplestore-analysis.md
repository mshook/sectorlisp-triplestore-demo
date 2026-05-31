# Analysis: `sectorlisp-triplestore-demo`

A look at [mshook/sectorlisp-triplestore-demo](https://github.com/mshook/sectorlisp-triplestore-demo) —
SICP §4.4.1's query system, stripped down to run on SectorLISP's seven primitives
and reframed as an SPO (subject–predicate–object) triple store rather than the
original assertion database.

## What's clever

The interesting parts are all constraint-driven by the SectorLISP environment.

**The variable protocol.** Because SectorLISP gives you no character inspection,
you can't do the usual `?x` trick of peeking at a symbol's first character. So
`VARIABLEP` keys on *structure* instead: a query variable is a two-element list
whose `CAR` is the atom `?` (e.g. `(? P)`). That single decision ripples cleanly
through `MATCH`, `SUBS`, and `LOOKUP`.

**Consistency via re-match.** In `MATCH`, an already-bound variable is handled with
`(MATCH (CDR B) DAT BINDS)` — re-matching the bound value against the new data. That
is the quiet heart of the join: it enforces "same variable, same value" across
conjuncts.

**Joins for free.** `QUERY-AND` threads the binding stream through `MAPQUERY`, so
relational join just falls out — each conjunct re-queries against every binding set
accumulated so far.

**`FAIL` as a sentinel.** `MATCH` returns the atom `FAIL` on no-match rather than
`NIL`, since `NIL` is a legitimate match result. The sentinel is threaded through
explicitly. The right call.

**Rest-matching for free.** `Q8`'s pattern `(SLUMERVILLE . (? REST))` works with no
special machinery, because the whole thing is just cons-cell structure matching
anyway.

## Honest boundaries

Both are forced by the seven-primitive world and worth naming so nobody expects more.

- **Assertion-only subset.** The `CAN-DO-JOB` triples are pre-materialized ground
  facts, not rules — there's no rule-body unification or recursion, so you don't get
  SICP's derived-relation machinery. Fine for a demo, but it's the line where
  "triple store" and "the full SICP query language" diverge.
- **`EQ`-only comparison.** Salaries are opaque atoms. No `lisp-value`, no
  "earns more than" — arithmetic predicates are simply off the table.

## Possible next directions

- Push toward rule unification (the part deliberately omitted here).
- Keep it deliberately minimal as a teaching artifact.
