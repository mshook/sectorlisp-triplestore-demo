/*bin/echo '#-*- indent-tabs-mode:nil;js-indent-level:2;coding:utf-8 -*-

  SectorLISP v2.o (ISC License)
  Copyright 2021 Justine Tunney

  This file implements SectorLISP as a C / JavaScript polyglot and
  includes friendly branch features such as the undefined behavior
  exception handlers, optimized interning, and global definitions.

  POLYGLOT TRICK
  ==============
  This single file is simultaneously valid POSIX shell, C source, and
  JavaScript. The shell interprets the opening /*bin/echo line as a
  comment-less command that runs the embedded shell script, which
  downloads dependencies (bestline) and compiles the file as C with
  `cc -xc lisp.js`, then exec's the resulting binary. The C compiler
  sees the JS-only sections fenced inside `#if 0 ... #endif`. The JS
  engine sees the C-only sections fenced inside backtick-delimited
  template literals that are never evaluated.

  BUILD AND RUN (as shell script on Linux/Mac)
  ============================================
    chmod +x lisp.js
    ./lisp.js           # interactive REPL with readline editing
    ./lisp.js -t        # same but with function call tracing

(aset standard-display-table #x2029 [?¶]) ;; emacs protip '>/dev/null
curl -so bestline.c -z bestline.c https://justine.lol/sectorlisp2/bestline.c
curl -so bestline.h -z bestline.h https://justine.lol/sectorlisp2/bestline.h
[ lisp.js -nt lisp ] && cc -w -xc lisp.js bestline.c -o lisp
exec ./lisp "$@"
exit
*/

// The backtick begins a JS template literal that swallows the C preamble.
// `
#include "bestline.h"        /* GNU Readline replacement with Paredit support */
#ifndef __COSMOPOLITAN__
#include <assert.h>
#include <stdio.h>
#include <locale.h>
#include <setjmp.h>
#endif
/* In C, `var` and `function` are not keywords, so these macros let the
   shared code use JS-style declarations that compile cleanly as C. */
#define var int
#define function
/* Null is the pivot address of the memory array. It must be a power of two.
   Atoms are stored at positive offsets from Null; cons cells at negative
   offsets. 16384 = 0x4000. */
#define Null 16384
var M[Null * 2];       /* the entire heap: atoms at [Null..2*Null), cons at [0..Null) */
var (*funcall)();      /* pointer to either Funcall (normal) or Funtrace (trace mode) */
jmp_buf undefined;     /* C longjmp target for error recovery */
// ` — end of the JS template literal; C preprocessor never sees past here

// ============================================================
// MEMORY MODEL
// ============================================================
//
// SectorLISP redefines NULL to be the centre of a flat integer array M[].
// Two stacks grow outward from this pivot:
//
//   POSITIVE addresses  →  interned atom table (grows upward)
//   NEGATIVE addresses  →  cons cell heap      (grows downward)
//
// Array layout (M is indexed as M[Null + i]):
//
//   Index  0       = NIL  (the empty list / false value)
//   Index  1       = T    (true, once defined)
//   Index  2..     = other interned atoms
//   Index -1       = Cdr of first cons cell allocated
//   Index -2       = Car of first cons cell allocated
//   Index -3, -4   = second cons cell  ...  and so on
//
// An atom at index h occupies two slots in M[]:
//   M[Null + h]           = the first character code of this atom's name
//   M[Null + h + Null/2]  = index of the next character atom in the chain
//                           (0 = end of name)
//
// A cons cell at index cx occupies two adjacent slots:
//   M[Null + cx]     = Car  (set by Set(--cx, cdr); Set(--cx, car))
//   M[Null + cx + 1] = Cdr
//
// The sign of an integer therefore encodes its type:
//   positive (>= 0)  →  atom (address in atom table)
//   negative (< 0)   →  cons cell (address in cons heap)
//   zero (0 / -0)    →  NIL / () — both evaluate as falsy in Eval,
//                        but Print distinguishes them via the sign trick
//                        (1./-0 == -Infinity in IEEE 754)
//
// This layout means the entire LISP machine — atoms, cons cells, and
// the interpreter — fits in a 32 KB array: 16 KB for atoms, 16 KB for
// cons cells.

// ============================================================
// GLOBAL VARIABLES
// ============================================================

// ---- Emulated CPU registers --------------------------------

/* ax: hash accumulator.
   Updated character-by-character in ReadAtom as each character of a
   symbol name is consumed. Its value feeds Hash() to compute the initial
   probe slot for each new atom. Shared between ReadAtom calls for
   multi-character atoms: the hash of "ABC" incorporates all three
   characters in sequence. */
var ax;

/* cx: cons stack pointer.
   Starts at 0 and decrements by 2 each time Cons() is called, since
   each cons cell occupies two slots (car at cx, cdr at cx+1).
   The current "top of heap" is always cx; the most recently allocated
   cell is at cx..cx+1. Because cons cells live at negative indices,
   a lower (more negative) cx means more cells have been allocated.
   The garbage collector moves cx back toward 0 when cells are freed. */
var cx;

/* dx: read-ahead character buffer (one-character lookahead).
   ReadChar() returns the *previous* character and stores the new one
   in dx. This means dx always holds the character *after* the one
   just returned — a one-position lookahead used by ReadAtom to decide
   whether to keep reading more characters into a multi-char atom. */
var dx;

// ---- Trace / debug state -----------------------------------

/* depth: indentation level for Funtrace output.
   Incremented by 2 on each function entry, decremented by 2 on return.
   Passed to Indent() which prints that many spaces before each trace line. */
var depth;

/* panic: print-output safety valve.
   When non-zero, PrintList() stops printing after this many Print() calls
   and emits "…" instead. Set to ~10000 in trace mode to prevent runaway
   output from infinite or deeply recursive programs. Zero means unlimited. */
var panic;

/* fail: C-only exit code counter.
   Incremented (capped at 255) each time Throw() is called in C mode.
   Passed to exit() when stdin is exhausted, so the process exit code
   reflects how many errors were encountered. Unused in JS mode. */
var fail;

// ---- Performance counters ----------------------------------
// All four are reset to 0 at the start of each Lisp() evaluation run
// and displayed in the stats bar of the web simulator.

/* cHeap: the lowest (most negative) cx value seen during the current run.
   Tracks the high-water mark of cons cell allocation, separately from cx
   which moves back up after GC. Used to compute the "heap" stat:
   heap = (-cHeap >> 1) - (-cx >> 1), i.e., cells allocated but later freed. */
var cHeap;

/* cGets: count of Get() calls (memory reads). */
var cGets;

/* cSets: count of Set() calls (memory writes). */
var cSets;

/* cReads: count of Read() calls (s-expressions parsed from input). */
var cReads;

/* cPrints: count of Print() calls (values printed to output).
   Also used by PrintList() to check against `panic` to cut off
   runaway output. */
var cPrints;

// ---- Interned builtin atom addresses -----------------------
// These are set once by LoadBuiltins() and never change.
// Each holds the positive integer address (in the atom table) of the
// corresponding interned symbol. Apply() and Eval() compare against
// these to dispatch builtins in O(1) without string comparison.

var kEq;     /* address of the interned atom EQ   */
var kCar;    /* address of the interned atom CAR  */
var kCdr;    /* address of the interned atom CDR  */
var kCond;   /* address of the interned atom COND */
var kAtom;   /* address of the interned atom ATOM */
var kCons;   /* address of the interned atom CONS */
var kQuote;  /* address of the interned atom QUOTE */
var kDefine; /* address of the interned atom DEFINE (friendly branch only) */

// ============================================================
// MEMORY PRIMITIVES
// ============================================================

/* Get(i) — read a word from the heap at logical address i.
   Physical array index is Null + i, so the pivot address maps to M[Null].
   Increments the cGets performance counter. */
function Get(i) {
  ++cGets;
  return M[Null + i];
}

/* Set(i, x) — write x to the heap at logical address i.
   Increments the cSets performance counter. */
function Set(i, x) {
  ++cSets;
  M[Null + i] = x;
}

// ============================================================
// CONS CELL ACCESSORS
// ============================================================

/* Car(x) — return the first element of the cons cell at address x.
   If x is 0 (NIL), returns +0 (NIL), since NIL's car is NIL.
   If x is positive (an atom), that's undefined behaviour: throws an
   error list (CAR x) rather than silently reading garbage — this is
   the "friendly branch" improvement over bare SectorLISP. */
function Car(x) {
  if (x > 0) Throw(List(kCar, x));   /* atoms have no car */
  return x ? Get(x) : +0;            /* NIL.car = NIL */
}

/* Cdr(x) — return the rest of the cons cell at address x.
   If x is 0 (NIL), returns -0 (the empty list), since NIL's cdr is NIL/().
   Same atom guard as Car. */
function Cdr(x) {
  if (x > 0) Throw(List(kCdr, x));   /* atoms have no cdr */
  return x ? Get(x + 1) : -0;       /* NIL.cdr = () */
}

/* Cons(car, cdr) — allocate a new cons cell and return its address.
   Decrements cx by 2 (two slots per cell) and writes cdr then car.
   Ordering matters: --cx gives the cdr slot first, then --cx again
   gives the car slot, so Car(result) = Get(cx) and Cdr(result) = Get(cx+1).
   Throws kCons if the heap is full (cx == -Null).
   Updates cHeap to track the maximum allocation depth. */
function Cons(car, cdr) {
  if (cx == -Null) Throw(kCons);   /* out of cons cell memory */
  Set(--cx, cdr);                  /* write cdr at cx (after first decrement) */
  Set(--cx, car);                  /* write car at cx (after second decrement) */
  if (cx < cHeap) cHeap = cx;     /* track high-water mark */
  return cx;                       /* return address of the new cell */
}

// ============================================================
// ATOM INTERNING
// ============================================================
//
// Atoms are stored in a open-addressed hash table occupying the positive
// half of M[]. Each atom h uses two slots:
//
//   M[Null + h]           = the Unicode code point of this character
//   M[Null + h + Null/2]  = the address of the *rest* of the atom's name
//                           (0 = this is the last/only character)
//
// So an atom is really a linked list of single characters, threaded
// through the hash table. The atom's address is the index of its
// *first* character. Two atoms are EQ if and only if they have the
// same integer address — no string comparison needed at runtime.
//
// The table has Null/2 = 8192 first-character slots and 8192 continuation
// slots (at offset Null/2 within M[]). Quadratic probing resolves
// collisions.
//
// Special case: NIL is pre-loaded at index 0 (the NULL address itself),
// which is why NIL == 0 == false in every boolean context.

/* Probe(h, p) — compute the next probe address for quadratic probing.
   Given current slot h and step number p, the next slot is h + p².
   Masked to stay within [0, Null/2). */
function Probe(h, p) {
  return (h + p * p) & (Null / 2 - 1);
}

/* Hash(h, x) — mix one more character x into the running hash h.
   The magic numbers 3083 and 3191 are chosen so that NIL interns at
   slot 0 and T interns at slot 1, matching the pre-loaded values.
   See hash.c / hash.com in the sectorlisp repository for derivation. */
function Hash(h, x) {
  return (((h + x) * 3083 + 3191) >> 4) & (Null / 2 - 1);
}

/* Intern(x, y, h, p) — find or create the atom whose first char is x
   and whose name-continuation address is y.
   h is the current probe slot; p is the probe step number.
   If slot h already contains (x, y) we found an existing atom — return h.
   If slot h is occupied by a different atom, probe to the next slot.
   If slot h is empty (Get(h) == 0), write (x, y) and return h.
   This is called recursively by ReadAtom as it traverses the atom chain. */
function Intern(x, y, h, p) {
  if (x == Get(h) && y == Get(h + Null / 2)) return h;  /* found */
  if (Get(h)) return Intern(x, y, Probe(h, p), p + 1);  /* collision: reprobe */
  Set(h, x);             /* write first char */
  Set(h + Null/2, y);    /* write continuation */
  return h;              /* new atom created at h */
}

// ============================================================
// READER
// ============================================================
//
// The reader converts a stream of characters into an S-expression (an
// integer that is either an atom address or a cons cell address).
// ReadChar() provides one-character lookahead via the dx register.
// All input is uppercased by the caller (bestlineUppercase in C,
// s.toUpperCase() in JS) before being fed to the reader.

/* ReadAtom() — read the longest atom starting at the current position.
   Skips leading whitespace, then reads characters until it hits a
   delimiter (whitespace or a paren-class character, i.e. <= ')').
   For each character it calls Intern() to build a linked chain in the
   atom table.
   ax accumulates the rolling hash across characters; y accumulates the
   "rest of the name" pointer (the address of the following character's
   atom in the chain). The final call to Intern returns the address of
   the *first* character of the complete atom name.
   Note: '(' is ASCII 40, ')' is ASCII 41, so `x > Ord(')')` means any
   character that is not a paren or whitespace — i.e., a valid atom char. */
function ReadAtom() {
  var x, y;
  ax = y = 0;                                 /* reset hash and continuation */
  do x = ReadChar();                           /* skip whitespace */
  while (x <= Ord(' '));
  if (x > Ord(')') && dx > Ord(')')) y = ReadAtom();  /* recurse for rest of name */
  return Intern(x, y, (ax = Hash(x, ax)), 1); /* intern first char with rest */
}

/* ReadList() — read a list (called after '(' has been consumed by ReadAtom).
   Reads successive items and conses them together into a list.
   Termination: if the next item's first char is ')' (i.e. the atom at
   that address has Get(x) == ')'), return the empty list -0.
   Dotted pair: if the next item is a lone '.', read one more item and
   return it directly as the cdr (so (A . B) becomes (Cons A B) = B as cdr).
   Otherwise: cons this item with the recursively read rest. */
function ReadList() {
  var x, y;
  if ((x = Read()) > 0) {               /* read next item */
    if (Get(x) == Ord(')')) return -0;  /* closing paren: end of list */
    if (Get(x) == Ord('.') && !Get(x + 1)) {  /* lone dot: dotted pair */
      x = Read();                       /* read the cdr element */
      y = ReadList();                   /* read past the closing ')' */
      if (!y) {
        return x;                       /* (A . B) — x is the cdr */
      } else {
        Throw(y);                       /* syntax error: junk after dot */
      }
    }
  }
  return Cons(x, ReadList());           /* normal case: x is car, recurse for cdr */
}

/* Read() — top-level reader. Increments cReads.
   Reads an atom. If the atom's first char is '(' this is a list —
   delegate to ReadList(). Otherwise return the atom as-is.
   This is the only entry point for the evaluator's input. */
function Read() {
  var t;
  ++cReads;
  t = ReadAtom();
  if (Get(t) != Ord('(')) return t;   /* atom: return directly */
  return ReadList();                   /* list: parse contents */
}

// ============================================================
// PRINTER
// ============================================================
//
// The printer converts an S-expression back into characters.
// PrintChar() is environment-specific (fputwc in C, string append in JS).
// Atoms and cons cells are distinguished by the sign of their address.

/* PrintAtom(x) — print the atom at address x.
   Walks the character chain: Get(x) is the char code of the first
   character; Get(x + Null/2) is the address of the next character atom
   (0 = end of name). Loops until the continuation is 0. */
function PrintAtom(x) {
  do PrintChar(Get(x));                /* print this character */
  while ((x = Get(x + Null / 2)));    /* advance to next char atom */
}

/* PrintList(x) — print the cons cell at address x as a list.
   Opens with '(', prints each element separated by spaces.
   If the final cdr is not NIL (i.e., it is a non-list cons or an atom),
   prints " . value" to produce dotted-pair notation.
   If panic is set and cPrints exceeds it, truncates with "…". */
function PrintList(x) {
  PrintChar(Ord('('));
  if (x < 0) {                          /* non-empty list */
    Print(Car(x));                      /* print first element */
    while ((x = Cdr(x))) {             /* advance to cdr */
      if (panic && cPrints > panic) {   /* truncation guard */
        PrintChar(Ord(' '));
        PrintChar(0x2026);             /* … */
        break;
      }
      if (x < 0) {
        PrintChar(Ord(' '));
        Print(Car(x));                  /* print next element */
      } else {
        PrintChar(Ord(' '));
        PrintChar(Ord('.'));
        PrintChar(Ord(' '));
        Print(x);                       /* improper list: print final cdr */
        break;
      }
    }
  }
  PrintChar(Ord(')'));
}

/* Print(x) — dispatch between atom and list printing.
   Uses the IEEE 754 sign trick: 1./x < 0 is true when x is any negative
   number (a cons cell) OR when x is -0 (the empty list ()).
   Both should be printed as lists. Positive x (atoms including NIL=0
   and +0) are printed as atoms.
   Note: 1./0 == +Infinity (positive), 1./-0 == -Infinity (negative),
   so this correctly distinguishes NIL (print as "NIL") from () (print
   as "()"). */
function Print(x) {
  ++cPrints;
  if (1./x < 0) {
    PrintList(x);    /* cons cell or empty list () */
  } else {
    PrintAtom(x);   /* atom or NIL */
  }
}

// ============================================================
// UTILITIES
// ============================================================

/* List(x, y) — construct the two-element list (x y).
   Equivalent to (CONS x (CONS y NIL)) in Lisp.
   Used to build error values like (CAR atom) when Car is called on an atom. */
function List(x, y) {
  return Cons(x, Cons(y, -0));
}

// ============================================================
// GARBAGE COLLECTOR  (the ABC collector)
// ============================================================
//
// SectorLISP uses a copying garbage collector that takes only 40 bytes
// of assembly. It exploits the functional (acyclic, immutable) nature
// of LISP data to guarantee that the only live data after an Eval() call
// is the result value itself — everything else allocated during that call
// can be discarded.
//
// The algorithm uses three heap positions:
//   A = cx before the Eval() call  (saved by the caller: `var A = cx`)
//   B = cx after  the Eval() call  (captured inside Gc as `var B = cx`)
//   C = cx after  copying the result downward (captured after Copy())
//
// Steps:
//   1. Copy the result x (which lives between B and A) to fresh space
//      below B, using Copy(x, A, A-B). The offset A-B shifts all new
//      addresses so they land just below A in the final position.
//      After Copy, C = cx (the new bottom of the copied result).
//   2. Slide the copied cells from [C..B) up to [A-size..A), i.e.,
//      memcpy upward by (A - B) words.
//   3. Set cx = A - (B - C), the new top of the heap.
//
// The effect: the region [old B .. old A] (all cells created during the
// Eval call but not part of the result) is silently discarded. The result
// is compacted into the space just below A, and the heap pointer is reset
// to exactly account for it. No bookkeeping, no free lists, no marks.
//
// This works because:
//   - LISP data is acyclic, so Copy() terminates.
//   - Nothing above A is part of the result (it belongs to callers).
//   - Copy() skips cells at or above A (the `x < m` check), so it never
//     accidentally re-copies the caller's data.

/* Copy(x, m, k) — recursively copy the cons structure rooted at x.
   Only copies cells strictly below m (i.e., in the range allocated
   during the current Eval call). Atoms (x >= 0) and cells already above
   m (x >= m, i.e., belonging to callers) are returned unchanged.
   k is a constant offset added to every newly allocated address to
   produce the final "shifted" address in the destination area. */
function Copy(x, m, k) {
  return x < m
    ? Cons(Copy(Car(x), m, k),
           Copy(Cdr(x), m, k)) + k   /* copy cell, shift result address */
    : x;                              /* atom or caller-owned cell: unchanged */
}

/* Gc(A, x) — run the ABC garbage collector.
   A is the heap position saved before the Eval() call.
   x is the result value to preserve.
   After Gc, cx is reset so that only the result's cells remain,
   neatly packed just below A. */
function Gc(A, x) {
  var C, B = cx;
  x = Copy(x, A, A - B), C = cx;      /* step 1: copy result downward */
  while (C < B) Set(--A, Get(--B));   /* step 2: slide copied cells up to A */
  return cx = A, x;                   /* step 3: reset cx; return result */
}

// ============================================================
// EVALUATOR
// ============================================================
//
// This is John McCarthy's metacircular evaluator, implemented in the
// minimal subset of Lisp that SectorLISP provides. Alan Kay called this
// "the Maxwell's equations of software".
//
// Every expression is evaluated in an environment `a`, which is an
// association list (alist) of the form:
//   ((var1 . val1) (var2 . val2) ...)
// Variables are looked up by scanning this list from the front.
// Function application extends the environment by prepending new bindings.

/* Evcon(c, a) — evaluate a COND clause list c in environment a.
   c has the form ((test1 expr1) (test2 expr2) ...).
   Evaluates the test of each clause in turn; returns the value of the
   first expr whose test is non-NIL. Throws kCond if c is exhausted
   (no clause matched) or malformed (not a cons). */
function Evcon(c, a) {
  if (c >= 0) Throw(kCond);                    /* malformed or exhausted COND */
  if (Eval(Car(Car(c)), a)) {                   /* test the first clause's test */
    return Eval(Car(Cdr(Car(c))), a);           /* test passed: return its expr */
  } else {
    return Evcon(Cdr(c), a);                    /* test failed: try next clause */
  }
}

/* Peel(x, a) — optimisation for Pairlis.
   If the front of the environment alist already binds variable x, drop
   that binding (return Cdr(a)) before prepending the new one. This
   prevents repeated tail calls from accumulating stale duplicate bindings
   for the same variable, which would slow down Assoc. Without this,
   a recursive function called 1000 times would leave 1000 copies of
   its parameter in the alist. */
function Peel(x, a) {
  return a && x == Car(Car(a)) ? Cdr(a) : a;
}

/* Evlis(m, a) — evaluate a list of arguments m in environment a.
   Returns a new list with each element evaluated.
   Used by Apply to evaluate the actual arguments before binding them
   to the lambda's formal parameters. */
function Evlis(m, a) {
  return m ? Cons(Eval(Car(m), a),
                  Evlis(Cdr(m), a)) : m;
}

/* Pairlis(x, y, a) — bind formal parameters x to actual values y,
   prepending the new bindings to environment a.
   x = (param1 param2 ...), y = (val1 val2 ...).
   Returns ((param1 . val1) (param2 . val2) ... . a).
   Calls Peel on a before each prepend to remove any stale binding for
   the same variable (the Peel optimisation described above). */
function Pairlis(x, y, a) {
  return x ? Cons(Cons(Car(x), Car(y)),
                  Pairlis(Cdr(x), Cdr(y),
                          Peel(Car(x), a)))
           : a;
}

/* Assoc(x, y) — look up variable x in environment alist y.
   Walks the alist linearly. Returns the value (cdr of the matching pair).
   Throws x (the unbound variable's atom address) if x is not found.
   This throw propagates up as an error in the friendly branch. */
function Assoc(x, y) {
  if (!y) Throw(x);                                  /* unbound variable */
  return x == Car(Car(y)) ? Cdr(Car(y))              /* found: return value */
                          : Assoc(x, Cdr(y));        /* not yet: keep scanning */
}

/* Apply(f, x, a) — apply function f to evaluated argument list x in env a.
   f may be:
     - a cons cell (f < 0): a lambda, of the form (LAMBDA (params) body).
       Car(f) would be LAMBDA (ignored — any atom works as "lambda keyword").
       Car(Cdr(f)) = parameter list.
       Car(Cdr(Cdr(f))) = body expression.
       Evaluate body in env extended with (params . args).
     - kCons: the builtin CONS — allocate a new cons cell.
     - kEq:   the builtin EQ   — pointer equality test (works for atoms only).
     - kAtom: the builtin ATOM — true iff x is an atom (non-negative address).
     - kCar:  the builtin CAR  — return the car of the argument.
     - kCdr:  the builtin CDR  — return the cdr of the argument.
     - any other atom: a named function — look it up in env and re-apply.
       This case goes through `funcall` (either Funcall or Funtrace) so
       that the garbage collector and/or tracer can wrap it. */
function Apply(f, x, a) {
  if (f < 0)      return Eval(Car(Cdr(Cdr(f))), Pairlis(Car(Cdr(f)), x, a));
  if (f == kCons) return Cons(Car(x), Car(Cdr(x)));
  if (f == kEq)   return Car(x) == Car(Cdr(x));   /* pointer equality */
  if (f == kAtom) return Car(x) >= 0;              /* atom = non-negative */
  if (f == kCar)  return Car(Car(x));
  if (f == kCdr)  return Cdr(Car(x));
  return funcall(cx, f, Assoc(f, a), x, a);        /* look up and apply */
}

/* Eval(e, a) — evaluate expression e in environment a.
   Five cases, tested in order:
   1. e == 0 (NIL): self-evaluating, return NIL.
   2. e > 0 (atom): variable reference — look it up in a with Assoc.
   3. Car(e) == kQuote: return the unevaluated argument Car(Cdr(e)).
   4. Car(e) == kCond: evaluate the COND clause list with Evcon.
   5. Otherwise: function application. Evaluate the operator (Car(e))
      and all arguments (Evlis(Cdr(e))) then Apply. */
function Eval(e, a) {
  if (!e) return e;                              /* NIL → NIL */
  if (e > 0) return Assoc(e, a);                /* atom → variable lookup */
  if (Car(e) == kQuote) return Car(Cdr(e));     /* (QUOTE x) → x */
  if (Car(e) == kCond) return Evcon(Cdr(e), a); /* (COND ...) → clause scan */
  return Apply(Car(e), Evlis(Cdr(e), a), a);    /* (f a1 a2 ...) → apply */
}

// ============================================================
// FUNCALL DISPATCH  (normal vs. trace mode)
// ============================================================
//
// Apply's final case (named function lookup) goes through `funcall` rather
// than calling Gc and Apply directly. This lets the main loop swap in
// Funtrace without touching the core evaluator.

/* Funcall(A, f, l, x, a) — normal (non-tracing) function call.
   A = heap position before this call (for GC).
   f = the function's name atom (not used here; used by Funtrace).
   l = the function's value (the lambda cons cell, from Assoc(f, a)).
   x = evaluated argument list.
   a = current environment.
   Applies l to x in environment a, then runs Gc to discard
   any temporaries created during the call. */
function Funcall(A, f, l, x, a) {
  return Gc(A, Apply(l, x, a));
}

/* Funtrace(A, f, l, x, a) — tracing function call.
   Same as Funcall but prints the function name and arguments before the
   call and the name, arguments, and result after it, indented by `depth`
   spaces. `depth` is incremented by 2 for the recursive call and
   decremented on return, producing a nested visual indentation.
   The arrow character → (U+2192) separates arguments from result. */
function Funtrace(A, f, l, x, a) {
  var y;
  Indent(depth);
  Print(f);            /* function name */
  Print(x);            /* argument list */
  PrintChar(Ord('\n'));
  depth += 2;
  y = Funcall(cx, f, l, x, a);   /* note: uses cx, not A, so inner GC is independent */
  depth -= 2;
  Indent(depth);
  Print(f);
  Print(x);
  PrintChar(Ord(' '));
  PrintChar(0x2192);   /* → */
  PrintChar(Ord(' '));
  Print(y);
  PrintChar(Ord('\n'));
  return y;
}

/* Indent(i) — print i space characters recursively. */
function Indent(i) {
  if (i) {
    PrintChar(Ord(' '));
    Indent(i - 1);
  }
}

// ============================================================
// DEFINE  (friendly branch: persistent global bindings)
// ============================================================
//
// The friendly branch adds DEFINE, which stores top-level bindings in a
// persistent alist `a` that survives between expressions. Unlike function
// parameters (which are cleaned up by GC), DEFINEs must outlive any
// individual evaluation. The `Compact` + `Remove` combo ensures the alist
// stays small: rebinding a name replaces its old entry rather than
// shadowing it.
//
// CRITICAL: The main loop must NOT call Gc after a Define. The newly
// compacted alist cells live between A (the saved cx before the DEFINE
// expression) and the current cx. Calling Gc(A, 0) would discard all of
// them, wiping every definition. The main loop therefore calls `continue`
// after Define and only calls Gc after evaluating non-DEFINE expressions.

/* DumpAlist(a) — print the entire environment alist in raw form.
   Prints ((name . value) ...) in one block. Used internally for
   session serialisation (SaveAlist in JS). */
function DumpAlist(a) {
  PrintChar(Ord('('));
  PrintChar(Ord('\n'));
  for (; a; a = Cdr(a)) {
    PrintChar(Ord('('));
    Print(Car(Car(a)));
    PrintChar(Ord(' '));
    PrintChar(Ord('.'));
    PrintChar(Ord(' '));
    Print(Cdr(Car(a)));
    PrintChar(Ord(')'));
    PrintChar(Ord('\n'));
  }
  PrintChar(Ord(')'));
}

/* DumpDefines(a) — print the alist as a sequence of DEFINE expressions.
   Recurses to print in definition order (oldest first), then prints
   each entry as (DEFINE name . value). Used by the "Share" / "Dump"
   button to serialise the session as re-loadable source. */
function DumpDefines(a) {
  if (a) {
    DumpDefines(Cdr(a));           /* recurse first to reverse order */
    PrintChar(Ord('('));
    Print(kDefine);
    PrintChar(Ord(' '));
    Print(Car(Car(a)));            /* name */
    PrintChar(Ord(' '));
    PrintChar(Ord('.'));
    PrintChar(Ord(' '));
    Print(Cdr(Car(a)));            /* value */
    PrintChar(Ord(')'));
    PrintChar(Ord('\n'));
  }
}

/* LoadBuiltins() — bootstrap the interpreter by reading the pre-loaded
   builtin atom names and capturing their interned addresses.
   The first thing fed to the reader is the string:
     "NIL T EQ CAR CDR ATOM COND CONS QUOTE DEFINE "
   Reading it interns each atom and returns its address. The first two
   (NIL and T) are discarded by Read();Read() because their addresses are
   already known (NIL = 0, T = 1 by the hash function's design). The
   remaining eight addresses are stored in the k* globals. */
function LoadBuiltins() {
  Read();      /* NIL   — discarded; already at address 0 */
  Read();      /* T     — discarded; already at address 1 (hash-guaranteed) */
  kEq    = Read();   /* EQ    */
  kCar   = Read();   /* CAR   */
  kCdr   = Read();   /* CDR   */
  kAtom  = Read();   /* ATOM  */
  kCond  = Read();   /* COND  */
  kCons  = Read();   /* CONS  */
  kQuote = Read();   /* QUOTE */
  kDefine= Read();   /* DEFINE */
}

/* Crunch(e, B) — deduplicate cons cells when compacting the alist.
   Traverses e recursively. For each cons cell, first crunches car and cdr,
   then scans the freshly allocated cells (from B-2 down to cx) to see if
   an identical cell already exists. If so, returns a reference to it
   (adjusted by -B to give the correct shifted address). Otherwise
   allocates a fresh cell. The result: the alist is stored as a
   maximally shared DAG with no redundant cells. */
function Crunch(e, B) {
  var x, y, i;
  if (e >= 0) return e;                   /* atom: shared by address, no copy */
  x = Crunch(Car(e), B);                  /* crunch car subtree */
  y = Crunch(Cdr(e), B);                  /* crunch cdr subtree */
  for (i = B - 2; i >= cx; i -= 2) {     /* scan freshly allocated cells */
    if (x == Car(i) && y == Cdr(i)) {
      return i - B;                       /* found an identical cell: reuse it */
    }
  }
  return Cons(x, y) - B;                  /* no duplicate: allocate new cell */
}

/* Compact(x) — fully compact and deduplicate the structure x.
   Saves B = cx, calls Crunch (which allocates deduplicated cells below B
   using -B offset notation), then slides the new cells from [C..B) up to
   the top of the heap at negative addresses starting from 0 (A = 0).
   Sets cx = A - (B - C). Returns the compacted value of x.
   This is called after every Define to ensure the global alist takes
   minimal space and shares structure wherever possible. */
function Compact(x) {
  var C, B = cx, A = 0;
  x = Crunch(x, B), C = cx;              /* crunch into temporary area */
  while (C < B) Set(--A, Get(--B));      /* slide cells to top of heap */
  return cx = A, x;                      /* reset cx; return compacted root */
}

/* Remove(x, y) — remove any existing binding for name x from alist y.
   Walks y and reconstructs it without the pair whose car is x.
   Used by Define so that rebinding a name replaces rather than shadows
   the old definition. */
function Remove(x, y) {
  if (!y) return y;                          /* empty alist: nothing to remove */
  if (x == Car(Car(y))) return Cdr(y);       /* found: skip this entry */
  return Cons(Car(y), Remove(x, Cdr(y)));    /* not this one: keep and recurse */
}

/* Define(x, a) — add a new global binding to alist a.
   x is the (name . value) pair from the DEFINE expression (i.e., Cdr of
   the whole (DEFINE name . value) form after the reader processes it).
   Removes any previous binding for the same name, prepends the new pair,
   then compacts the whole alist to deduplicate structure.
   Returns the new alist, which the caller stores as the persistent env. */
function Define(x, a) {
  return Compact(Cons(x, Remove(Car(x), a)));
}

// ============================================================
// C-SPECIFIC CODE  (compiled by cc -xc lisp.js)
// ============================================================
// The `// \`` below ends the JS template literal that swallowed the C
// preamble at the top; everything until `#if 0` is parsed as C.
// `
////////////////////////////////////////////////////////////////////////////////
// ANSI POSIX C Specific Code

/* Ord(c) — in C, characters are already integers, so this is identity.
   In JS it's s.charCodeAt(0). The macro/function unifies the two. */
Ord(c) {
  return c;
}

/* Throw(x) — signal a runtime error in C.
   Increments the fail counter (capped at 255 for exit code use) and
   longjmps to the `undefined` buffer, which is set in main()'s setjmp
   call. The ~x encoding inverts all bits so that 0 (which setjmp returns
   for normal flow) is never confused with a thrown value. */
Throw(x) {
  if (fail < 255) ++fail;
  longjmp(undefined, ~x);
}

/* PrintChar(b) — write one Unicode code point to stdout via fputwc. */
PrintChar(b) {
  fputwc(b, stdout);
}

/* SaveAlist(a) — no-op in the C implementation.
   In JS this serialises the alist to localStorage. */
SaveAlist(a) {
}

/* ReadChar() — read one character from the current input source.
   Uses a static `line` pointer that starts pointing at the builtin
   atom string ("NIL T EQ CAR CDR ATOM COND CONS QUOTE DEFINE "),
   then switches to reading lines from the bestline REPL.
   Handles UTF-8 multi-byte sequences by decoding them into a single int.
   Returns the *previous* character (one-position lookahead via `dx`):
   stores the new char in dx, returns the old dx. When readline returns
   NULL (EOF), exits with the fail count as exit code. */
ReadChar() {
  int b, c, t;
  static char *freeme;
  static char *line = "NIL T EQ CAR CDR ATOM COND CONS QUOTE DEFINE ";
  if (line || (line = freeme = bestlineWithHistory("* ", "sectorlisp"))) {
    if (*line) {
      c = *line++ & 0377;
      if (c >= 0300) {                  /* UTF-8 lead byte */
        for (b = 0200; c & b; b >>= 1) c ^= b;
        while ((*line & 0300) == 0200) {  /* continuation bytes */
          c <<= 6;
          c |= *line++ & 0177;
        }
      }
    } else {
      free(freeme);
      freeme = 0;
      line = 0;
      c = '\n';                         /* end of line: emit newline */
    }
    t = dx;
    dx = c;
    return t;
  } else {
    exit(fail);                         /* EOF: exit with error count */
  }
}

/* main() — C entry point.
   Sets locale, installs the uppercase translator on bestline (so the
   user can type in lowercase), selects Funcall vs Funtrace based on -t,
   calls LoadBuiltins, then enters the REPL loop.
   For each expression: saves A = cx, sets up setjmp for error recovery,
   reads an s-expression. If it is a DEFINE, updates the alist without
   GC. Otherwise evaluates, prints the result, and runs Gc(A, 0) to
   clean up temporaries. Error recovery via setjmp restores normal flow
   after a Throw and prints '?' before the error value. */
main(argc, argv)
  char *argv[];
{
  var x, a, A;
  setlocale(LC_ALL, "");
  bestlineSetXlatCallback(bestlineUppercase);  /* auto-uppercase input */
  funcall = Funcall;
  for (x = 1; x < argc; ++x) {
    if (argv[x][0] == '-' && argv[x][1] == 't') {
      funcall = Funtrace;               /* -t flag: enable tracing */
    } else {
      fputs("Usage: ", stderr);
      fputs(argv[0], stderr);
      fputs(" [-t] <input.lisp >errput.lisp\n", stderr);
      exit(1);
    }
  }
  LoadBuiltins();
  for (a = 0;;) {                       /* a = global alist (starts empty) */
    A = cx;                             /* save heap position before eval */
    if (!(x = setjmp(undefined))) {     /* set recovery point */
      x = Read();
      if (x < 0 && Car(x) == kDefine) {
        a = Define(Cdr(x), a);         /* DEFINE: update alist, no GC */
        SaveAlist(a);
        continue;
      }
      x = Eval(x, a);                  /* evaluate expression */
    } else {
      x = ~x;                          /* error: recover thrown value */
      PrintChar('?');
    }
    Print(x);
    PrintChar('\n');
    Gc(A, 0);                          /* discard temporaries */
  }
}

// The `#if 0` hides the JS section from the C compiler.
// The `//\`` begins a new JS template literal to swallow the JS code
// from the C preprocessor's point of view (it never reaches there).
#if 0
// `
////////////////////////////////////////////////////////////////////////////////
// JavaScript Specific Code for https://justine.lol/

// ---- JS-only globals ----------------------------------------

/* a: the global DEFINE alist (persistent between expressions).
   In C this is a local in main(). In JS it lives at module scope so
   that the Lisp() evaluation function can update it across multiple calls. */
var a;

/* code: the current input string being parsed by the reader.
   Set by Load() to the uppercased source text plus a trailing newline.
   The reader advances `index` through this string. */
var code;

/* index: current read position within `code`.
   Advanced by ReadChar(). When index >= code.length, ReadChar returns 0
   (end of input). */
var index;

/* output: accumulates characters printed by PrintChar() during a run.
   Reset to "" at the start of each Lisp() call. Assigned to the output
   element's innerText at the end of Lisp(). */
var output;

/* funcall: the active function-call handler, either Funcall or Funtrace.
   In C this is a function pointer. In JS it is a plain variable holding
   a function reference. Swapped by SetUp() when the Trace button is pressed. */
var funcall;

/* M, Null: the heap array and its size.
   Declared here as var because JS requires them at module scope.
   Reset() reinitialises both. In C, Null is a compile-time constant and
   M is a static array; in JS they must be reassignable for Reset(). */
var M, Null;

/* DOM element references — cached in SetUp() to avoid repeated getElementById. */
var eOutput;   /* the output <pre> or <div> element */
var eEval;     /* the Eval button */
var eReset;    /* the Reset button */
var eLoad;     /* the Load button */
var eTrace;    /* the Trace button */
var ePrograms; /* the program dropdown container */
var eDump;     /* the Dump button */

/* Performance counter DOM references — updated by ReportUsage(). */
var eGets;     /* displays cGets */
var eSets;     /* displays cSets */
var eMs;       /* displays elapsed milliseconds */
var eAtoms;    /* displays count of interned atoms */
var eCode;     /* displays cons cells used by live code */
var eHeap;     /* displays cons cells used by heap above code */
var eReads;    /* displays cReads */
var eWrites;   /* (unused label reference, kept for layout symmetry) */
var eClear;    /* the Clear button */

// ---- JS error handling --------------------------------------

/* Throw(x) — in JS, raise an exception carrying x.
   The REPL's try/catch in Lisp() catches this and prints '?' + x. */
function Throw(x) {
  throw x;
}

// ---- Session management -------------------------------------

/* Reset() — reinitialise the entire machine from scratch.
   Zeros all counters and the alist, creates a fresh M array, re-interns
   the builtin atoms. Called at startup and when the user presses Reset.
   Note: M is created with new Array(Null*2) WITHOUT fill(0). This is
   intentional — the array is sparse in JS, which means reads of unset
   slots return undefined (falsy), which the code treats as 0. Filling
   would be O(Null) and is commented out to keep JSON serialisation small. */
function Reset() {
  var i;
  a = 0;
  cx = 0;
  cHeap = 0;
  cGets = 0;
  cSets = 0;
  cReads = 0;
  cPrints = 0;
  Null = 16384;
  M = new Array(Null * 2);
  // for (i = 0; i < M.length; ++i) {
  //   M[i] = 0; /* make json smaller */
  // }
  Load("NIL T EQ CAR CDR ATOM COND CONS QUOTE DEFINE ");
  LoadBuiltins()
}

// ---- Unicode output -----------------------------------------
// JS strings are UTF-16. PrintChar receives full Unicode code points
// (which may be above U+FFFF). The four helpers below encode them
// into one or two UTF-16 code units.

/* PrintU16(c) — append one UTF-16 code unit to output. */
function PrintU16(c) {
  output += String.fromCharCode(c);
}

function IsHighSurrogate(c) { return (0xfc00 & c) == 0xd800; }
function IsLowSurrogate(c)  { return (0xfc00 & c) == 0xdc00; }
function GetHighSurrogate(c){ return ((c - 0x10000) >> 10) + 0xD800; }
function GetLowSurrogate(c) { return ((c - 0x10000) & 1023) + 0xDC00; }

/* ComposeUtf16(c, d) — combine a surrogate pair into a Unicode code point. */
function ComposeUtf16(c, d) {
  return ((c - 0xD800) << 10) + (d - 0xDC00) + 0x10000;
}

/* PrintChar(c) — output a Unicode code point c.
   If c fits in BMP (< 0x10000): one UTF-16 unit.
   If c is a supplementary character (< 0x110000): surrogate pair.
   Otherwise: replacement character U+FFFD. */
function PrintChar(c) {
  if (c < 0x10000) {
    PrintU16(c);
  } else if (c < 0x110000) {
    PrintU16(GetHighSurrogate(c));
    PrintU16(GetLowSurrogate(c));
  } else {
    PrintU16(0xFFFD);
  }
}

/* Ord(s) — convert a JS string (first character) to a Unicode code point.
   Handles surrogate pairs so that characters above U+FFFF round-trip
   correctly through Ord/PrintChar. Returns U+FFFD for unpaired surrogates. */
function Ord(s) {
  var c, d;
  c = s.charCodeAt(0);
  if (IsHighSurrogate(c)) {
    if (code.length > 1 && IsLowSurrogate((d = s.charCodeAt(1)))) {
      c = ComposeUtf16(c, d);
    } else {
      c = 0xFFFD;
    }
  } else if (IsLowSurrogate(c)) {
    c = 0xFFFD;
  }
  return c;
}

// ---- JS reader input ----------------------------------------

/* ReadChar() — read one character from `code` string.
   Advances `index`, handles surrogate pairs for supplementary characters.
   Returns 0 (end of input) when index >= code.length, and also resets
   `code` to "" to signal end-of-input to subsequent calls.
   Like the C version: stores the new character in dx, returns the old dx
   (one-position lookahead).
   Throws 0 if code is empty (guards against calling after EOF). */
function ReadChar() {
  var c, d, t;
  if (code.length) {
    if (index < code.length) {
      c = code.charCodeAt(index++);
      if (IsHighSurrogate(c)) {
        if (index < code.length &&
            IsLowSurrogate((d = code.charCodeAt(index)))) {
          c = ComposeUtf16(c, d), ++index;
        } else {
          c = 0xFFFD;
        }
      } else if (IsLowSurrogate(c)) {
        c = 0xFFFD;
      }
    } else {
      code = "";
      c = 0;
    }
    t = dx;
    dx = c;
    return t;
  } else {
    Throw(0);
  }
}

// ---- Main evaluation loop -----------------------------------

/* Lisp() — run the evaluator on the current `code` string.
   Resets the per-run counters. Loops until dx is 0 (end of input).
   Skips whitespace. For each expression:
     - Saves A = cx (heap position for GC).
     - Reads one expression.
     - If it is a DEFINE, updates the global alist without GC (no continue
       here because JS doesn't need a setjmp recovery path around Define).
     - Otherwise evaluates, prints result + newline, then Gc(A, 0).
   On error (thrown by Throw), prints '?' and the error value, then Gc.
   After all expressions: updates DOM with output, saves alist, reports stats. */
function Lisp() {
  var x, A, d, t;
  d = 0;                  /* accumulated elapsed milliseconds */
  cGets = 0;
  cSets = 0;
  cHeap = cx;             /* snapshot current heap mark */
  cReads = 0;
  cPrints = 0;
  output = "";
  while (dx) {
    if (dx <= Ord(' ')) {
      ReadChar();           /* skip whitespace */
    } else {
      t = GetMillis();
      A = cx;               /* save heap position before each expression */
      try {
        x = Read();
        if (x < 0 && Car(x) == kDefine) {
          a = Define(Cdr(x), a);  /* DEFINE: persist binding, no Gc */
          continue;
        }
        x = Eval(x, a);
      } catch (z) {
        PrintChar(Ord('?'));
        x = z;              /* print error marker and fall through to Print */
      }
      Print(x);
      PrintChar(Ord('\n'));
      Gc(A, 0);             /* discard all temporaries from this expression */
      d += GetMillis() - t;
    }
  }
  eOutput.innerText = output;
  SaveAlist(a);
  SaveOutput();
  ReportUsage(d);
}

/* Load(s) — set `code` to the uppercased version of s + newline,
   reset `index` to 0, and prime dx with a space so ReadAtom's
   `while (x <= Ord(' '))` loop fires immediately on the first call. */
function Load(s) {
  index = 0;
  dx = Ord(' ');
  code = s.toUpperCase() + "\n";
}

// ---- Button handlers ----------------------------------------

/* OnEval() — called when the user clicks Eval.
   Loads the editor content and runs Lisp(). Also saves input to
   localStorage so it survives a page reload. */
function OnEval() {
  Load(g_editor.getValue());
  Lisp();
  SetStorage("input", g_editor.getValue());
}

function OnBeforeUnload() {
  SetStorage("input", g_editor.getValue());
}

/* OnDump() — print the current session's definitions as DEFINE expressions.
   Useful for serialising a session: the output can be pasted back in to
   restore all definitions. */
function OnDump() {
  var t;
  output = "";
  t = GetMillis();
  DumpDefines(a);
  eOutput.innerText = output;
  t = GetMillis() - t;
  SaveOutput();
  ReportUsage(t);
}

/* OnReset(e) — reset the machine.
   If Shift is NOT held: first dumps the current definitions to the output
   (so they are visible and can be copied before being wiped).
   Then calls Reset() to wipe the machine. Removes the saved alist from
   localStorage. */
function OnReset(e) {
  var t;
  output = "";
  t = GetMillis();
  try {
    if (!e.shiftKey) DumpDefines(a);
    eOutput.innerText = output;
    Reset();
  } catch (e) {
    /* ignored */
  }
  t = GetMillis() - t;
  RemoveStorage("alist");
  SaveOutput();
  ReportUsage(t);
}

function OnClear() {
  output = "";
  eOutput.innerText = output;
  SaveOutput();
  ReportUsage(0);
}

/* OnTrace() — run the current editor content in trace mode.
   Temporarily sets funcall = Funtrace and panic = 10000 (to truncate
   runaway output), then evaluates. Restores funcall and panic on return.
   Note: unlike OnEval, trace mode re-evaluates from scratch each time
   (Load() resets code and index), so prior DEFINEs in the alist are
   still present from the persistent `a`. */
function OnTrace() {
  var t;
  Load(g_editor.getValue());
  t = panic;
  depth = 0;
  panic = 10000;
  funcall = Funtrace;
  Lisp();
  funcall = Funcall;
  panic = t;
}

// ---- Dropdown (program loader) handlers ---------------------

function OnLoad() {
  if (ePrograms.className == "dropdown-content") {
    ePrograms.className = "dropdown-content show";
  } else {
    ePrograms.className = "dropdown-content";
  }
}

function OnWindowClick(e) {
  if (e.target && !e.target.matches("#load")) {
    ePrograms.className = "dropdown-content";
  }
}

function OnWindowKeyDown(e) {
  if (e.key == "Escape") {
    ePrograms.className = "dropdown-content";
  }
}

// ---- localStorage persistence -------------------------------

/* SaveAlist(a) — serialise the current alist to localStorage.
   Renders it via DumpAlist (raw alist syntax), then stores under the
   "alist" key. On next page load, RestoreMachine() can reload it. */
function SaveAlist(a) {
  output = "";
  DumpAlist(a);
  SetStorage("alist", output);
}

/* RestoreMachine() — restore session state from localStorage on page load.
   Three cases tried in order:
   1. If a saved "alist" string exists: Reset(), Load() the string, read
      the alist with Read(), Compact() it into the heap.
   2. If a legacy "machine" JSON blob exists (from an older serialisation
      format): restore M, a, cx directly.
   3. Otherwise: the machine is already fresh from Reset(). */
function RestoreMachine() {
  var v;
  if ((v = GetStorage("output"))) {
    eOutput.innerText = v;
  }
  if ((v = GetStorage("input"))) {
    g_editor.setValue(v);
  }
  if ((v = GetStorage("alist"))) {
    Reset();
    Load(v);
    a = Compact(Read());
  } else if ((v = JSON.parse(GetStorage("machine")))) {
    M = v[0];
    a = v[1];
    cx = v[2];
    cHeap = cx;
  }
}

function SaveOutput() {
  SetStorage("input", g_editor.getValue());
  SetStorage("output", eOutput.innerText);
}

// ---- Stats display ------------------------------------------

function FormatInt(i) {
  return i.toLocaleString();
}

function FormatDuration(d) {
  return d ? Math.round(d * 1000) / 1000 : 0;
}

/* ReportUsage(ms) — update all eight stat counters in the DOM.
   code  = number of cons cells currently live (= -cx >> 1).
   heap  = maximum cons cell depth reached minus current live cells.
   atom  = number of occupied slots in the atom hash table. */
function ReportUsage(ms) {
  var i, atom, code, heap;
  code = -cx >> 1;
  heap = -cHeap >> 1;
  for (atom = i = 0; i < Null / 2; ++i) {
    if (M[Null + i]) ++atom;
  }
  if (eGets)   eGets.innerText   = FormatInt(cGets);
  if (eSets)   eSets.innerText   = FormatInt(cSets);
  if (eMs)     eMs.innerText     = FormatInt(ms);
  if (eAtoms)  eAtoms.innerText  = FormatInt(atom);
  if (eCode)   eCode.innerText   = FormatInt(code);
  if (eHeap)   eHeap.innerText   = FormatInt(heap - code);
  if (eReads)  eReads.innerText  = FormatInt(cReads);
  if (ePrints) ePrints.innerText = FormatInt(cPrints);
}

/* Discount(f) — wrap a function f so it does not affect the performance
   counters. Returns a wrapper that saves cGets, cSets, and cHeap before
   calling f, then restores them after. Used in SetUp() to wrap Read,
   Print, and Define so that their internal overhead doesn't inflate the
   user-visible stats during the evaluation loop. */
function Discount(f) {
  return function() {
    var x, g, h, s;
    g = cGets;
    s = cSets;
    h = cHeap;
    x = f.apply(this, arguments);
    cHeap = h;
    cSets = s;
    cGets = g;
    return x;
  };
}

function GetMillis() {
  if (typeof performance != "undefined") {
    return performance.now();
  } else {
    return 0;
  }
}

// ---- localStorage helpers -----------------------------------

/* GetStorage / SetStorage / RemoveStorage — thin wrappers around
   localStorage with a per-page key prefix (g_lisp) and null-safe
   guards for environments where localStorage is unavailable. */
function GetStorage(k) {
  if (typeof localStorage != "undefined") {
    return localStorage.getItem(g_lisp + "." + k);
  } else {
    return null;
  }
}

function RemoveStorage(k) {
  if (typeof localStorage != "undefined") {
    localStorage.removeItem(g_lisp + "." + k);
  }
}

function SetStorage(k, v) {
  if (typeof localStorage != "undefined") {
    localStorage.setItem(g_lisp + "." + k, v);
  }
}

// ---- Initialisation -----------------------------------------

/* SetUp() — wire up DOM event handlers and restore the previous session.
   Called on DOMContentLoaded (or similar) by the embedding HTML page.
   Wraps Read, Print, and Define with Discount() so that the bootstrapping
   operations (LoadBuiltins, session restore) don't appear in the stats
   shown to the user. */
function SetUp() {
  funcall = Funcall;
  Read   = Discount(Read);     /* hide builtin-loading overhead from stats */
  Print  = Discount(Print);
  Define = Discount(Define);
  eLoad     = document.getElementById("load");
  eReset    = document.getElementById("reset");
  eTrace    = document.getElementById("trace");
  eOutput   = document.getElementById("output");
  eEval     = document.getElementById("eval");
  eClear    = document.getElementById("clear");
  eDump     = document.getElementById("dump");
  ePrograms = document.getElementById("programs");
  eGets     = document.getElementById("cGets");
  eSets     = document.getElementById("cSets");
  eMs       = document.getElementById("cMs");
  eAtoms    = document.getElementById("cAtoms");
  eCode     = document.getElementById("cCode");
  eHeap     = document.getElementById("cHeap");
  eReads    = document.getElementById("cReads");
  ePrints   = document.getElementById("cPrints");
  window.onkeydown = OnWindowKeyDown;
  if (window.onbeforeunload) window.onbeforeunload = OnBeforeUnload;
  if (ePrograms) window.onclick = OnWindowClick;
  if (eLoad)  eLoad.onclick  = OnLoad;
  if (eReset) eReset.onclick = OnReset;
  if (eTrace) eTrace.onclick = OnTrace;
  if (eEval)  eEval.onclick  = OnEval;
  if (eDump)  eDump.onclick  = OnDump;
  if (eClear) eClear.onclick = OnClear;
}

// `
#endif
// `
