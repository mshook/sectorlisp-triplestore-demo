# EVAL and APPLY in the SectorLISP Metacircular Evaluator

## EVAL(E A)

`EVAL` is a case analysis on the shape of the expression `E`, with `A` (the association list) threading the current variable bindings.

**Case 1 — `E` is an atom** (three sub-cases):
```
(ATOM E) →
  NIL  → NIL          (self-evaluating)
  T    → T            (self-evaluating)
  else → (ASSOC E A)  (variable lookup: find E in the alist, return CDR of the pair)
```

**Case 2 — `(CAR E)` is an atom** (special forms + named call):
```
QUOTE  → return the literal argument, unevaluated
COND   → EVCON: try each clause until one's test is truthy, eval its consequent
LAMBDA → return E itself  (no closure; the lambda expression IS the value)
else   → APPLY the named function to EVLIS-evaluated arguments
```

**Case 3 — `(CAR E)` is a compound expression** (anonymous application):
```
→ APPLY (CAR E) to EVLIS-evaluated arguments
```

---

## APPLY(F ARGS A)

`APPLY` receives:
- `F` — a function (atom name → look it up in `A`, or a `LAMBDA` expression)
- `ARGS` — already-evaluated argument list
- `A` — the *calling* environment

For a lambda `(LAMBDA (PARAMS) BODY)` applied to `ARGS` in `A`:
```
new-env = (CONS (PARAMS[0] . ARGS[0])
          (CONS (PARAMS[1] . ARGS[1])
          A))
→ EVAL(BODY, new-env)
```

Bindings are created with `CONS param arg`, so:
- atom arg → `(X . A)` — dotted pair, CDR = `A`
- list arg → `(X (A) B C)` — improper-looking list, CDR = `((A) B C)`

Both forms appear in the trace's environment column for this reason.

---

## The mutual recursion

```
EVAL ──APPLY──▶ EVAL
  ▲               │
  └──EVLIS────────┘
```

`EVLIS` evaluates each argument by calling `EVAL`, producing the list that `APPLY` receives. `APPLY` evaluates the body by calling `EVAL` with the extended environment. Every call nest is one turn of this loop.

---

## Worked example: the traced expression

```lisp
((LAMBDA (FF X) (FF X))
 (LAMBDA (X) (COND ((ATOM X) X) (T (FF (CAR X)))))
 (QUOTE ((A) B C)))
```

1. Outer LAMBDA takes `FF` and `X`, calls `(FF X)`.
2. EVLIS evaluates the two arguments — the inner LAMBDA evaluates to *itself* (Case 2/LAMBDA); `(QUOTE ((A) B C))` evaluates to the literal list.
3. APPLY binds `FF → (LAMBDA (X) …)`, `X → ((A) B C)` and evaluates `(FF X)` in that environment.
4. `(FF X)`: look up `FF` → the inner lambda; look up `X` → `((A) B C)`. APPLY with new binding `X → ((A) B C)`.
5. Body: `(ATOM X)` fails (X is a list), so evaluate `(FF (CAR X))`. `CAR X` = `(A)`. APPLY FF with `X → (A)`.
6. `(ATOM X)` fails again (X = `(A)`). `(FF (CAR X))`, `CAR (A)` = `A`. APPLY FF with `X → A` (dotted pair).
7. `(ATOM A)` succeeds → return `X` = **`A`**.

---

## The key design point: dynamic scope

`FF` appears free in the inner lambda's body, yet every recursive call finds it. This works because APPLY extends the *calling* environment — it doesn't capture a lexical closure when `LAMBDA` is evaluated. The environment chain at the deepest call is:

```
((X . A)                              ← innermost binding
 (X A)
 (X (A) B C)
 (FF LAMBDA (X) (COND …))            ← FF still reachable
 (X (A) B C))
```

Each APPLY prepends new bindings; each ASSOC/LOOKUP scans from the front and stops at the first match. Shadowing is free, and free variables resolve dynamically through the chain.
