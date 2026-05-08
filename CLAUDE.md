# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A demo implementing a Subject-Predicate-Object (SPO) triple store and pattern-matching query engine in two Lisp dialects, loaded with the Microshaft personnel database from SICP §4.4.1. There is no build system, test suite, or package manager — all files are self-contained Lisp source or standalone HTML.

## Running the Common Lisp version

```bash
clisp microshaft-spo.lisp
# or
sbcl --script microshaft-spo.lisp
```

`microshaft-spo.lisp` is fully self-contained: query engine, triple store macro, database assertions, and 13 example queries all in one file.

## Running the SectorLISP version

Open one of the HTML playground files in a browser (no server needed — they are static). Paste or load Lisp source into the editor. The multi-file version must be loaded in order:

1. `spo-functions.lisp` — foundation + query engine
2. `microshaft-db.lisp` — the database
3. `microshaft-queries.lisp` — example queries

`microshaft-spo-sectorlisp.lisp` is the all-in-one single-file version for SectorLISP.

## Architecture

### Two parallel implementations

| Aspect | Common Lisp (`microshaft-spo.lisp`) | SectorLISP (`.lisp` files) |
|---|---|---|
| Query variables | `?person` (symbols starting with `?`) | `(? P)` (two-element list; no character inspection in SectorLISP) |
| Database | Global `*db*` list; `add-fact` / `assert-triple` macro | Passed explicitly as a third argument to `QUERY` and `ANSWER`; DB is a zero-arg lambda returning a quoted list |
| Failure sentinel | `:fail` keyword | The atom `FAIL` |
| Extra combinator | `(test EXPR)` — substitutes vars then evals (enables arithmetic) | Not available — SectorLISP has no `eval`; salary comparisons use EQ only |
| Entry point | `(answer label query output)` — prints to stdout | `(ANSWER query output db)` — returns a list of instantiated templates |

### Query engine structure (shared across both versions)

Each function corresponds to a query combinator:

- `MATCH` — unification: matches a pattern against a datum, extending a bindings alist; returns `FAIL` on mismatch
- `LOOKUP` / `VARIABLEP` — variable protocol (recognises `(? NAME)` in SectorLISP; `?name` symbols in CL)
- `SUBS` / `MAP-SUBS` — substitution: walks a template replacing variables with their bound values
- `QUERY-SIMPLE` — linear scan of every fact, collecting all matches
- `QUERY-AND` — threads conjuncts through a growing stream of binding sets (`MAPQUERY` does the flatMap)
- `QUERY-OR` — unions results from each disjunct
- `QUERY-NOT` — negation-as-failure: succeeds only when the inner query finds nothing
- `QUERY` — dispatcher: routes on the first element of the expression (`AND`/`OR`/`NOT`/`TEST`; anything else goes to `QUERY-SIMPLE`)
- `ANSWER` — top-level entry: runs query against DB, instantiates the output template for each result

### Triple format

Every fact is `(TRIPLE SUBJECT PREDICATE OBJECT)`. Subjects are flat atoms (`BITDIDDLE-BEN`) except for `CAN-DO-JOB` triples where the subject is itself a list (e.g., `(COMPUTER WIZARD)`). The `MATCH` function handles this uniformly via the cons-cell recursion case.

### Browser playground (`sectorlisp-playground.html`)

A self-contained single-page app embedding `lisp-commented.js` (SectorLISP v2, a C/JS polyglot by Justine Tunney). The HTML file includes the SectorLISP interpreter inline and provides a two-panel editor/output UI. No external dependencies are fetched at runtime.
