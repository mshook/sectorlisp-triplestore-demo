;;;; microshaft-spo.lisp
;;;;
;;;; A Subject-Predicate-Object (SPO) triple store in Common Lisp,
;;;; built with the uLisp query engine (http://www.ulisp.com/show?2I60)
;;;; and loaded with the Microshaft personnel database from
;;;; SICP Section 4.4.1 (Abelson & Sussman).
;;;;
;;;; The uLisp query language runs unchanged in Common Lisp.
;;;; Run with:  clisp microshaft-spo.lisp
;;;;            sbcl --script microshaft-spo.lisp
;;;; Or load interactively:  (load "microshaft-spo.lisp")
;;;;
;;;; ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
;;;; ARCHITECTURE OVERVIEW
;;;;
;;;; The query engine stores facts as arbitrary lists in *db*.
;;;; We use the convention  (triple SUBJECT PREDICATE OBJECT)
;;;; so every fact is a proper SPO triple.
;;;;
;;;;   Subject   --- a flat symbol naming a resource  (bitdiddle-ben)
;;;;   Predicate --- a symbol naming a relation       (job, salary, supervisor)
;;;;   Object    --- any atom, number, or nested list ((computer wizard), 60000)
;;;;
;;;; Queries use pattern variables  ?name  (symbols starting with ?).
;;;; Combinators:  (and ...) (or ...) (not ...) (test <lisp-expr>)
;;;;
;;;; Key functions:
;;;;   (query PATTERN BINDS)   --- list of binding alists
;;;;   (answer PATTERN OUTPUT) --- print each result via OUTPUT template
;;;; ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

;;; ============================================================
;;; PART 1 --- THE QUERY ENGINE  (uLisp / Common Lisp)
;;; ============================================================

(defvar *db* '()
  "The triple store: a list of fact-lists.")

(defun clear-db ()
  "Reset the database to empty."
  (setq *db* '()))

(defun add-fact (&rest args)
  "Push ARGS (a single fact list) onto *db*."
  (push args *db*)
  args)

;;; ------ Variable detection ------------------------------------------------------------------------------------------------------------------
;;; A query variable is any symbol whose name begins with '?'
(defun variablep (x)
  (and (symbolp x)
       (> (length (symbol-name x)) 0)
       (char= (char (symbol-name x) 0) #\?)))

;;; ------ Pattern matching ------------------------------------------------------------------------------------------------------------------------
;;; Returns an extended binding alist, or the sentinel :fail.
;;; Bindings alist: ((VAR . VALUE) ...)
(defun match (pattern datum binds)
  (cond
    ;; Propagate failure
    ((eq binds :fail) :fail)
    ;; Literal equality (atoms, numbers, symbols)
    ((eql pattern datum) binds)
    ;; Variable: look up or extend bindings
    ((variablep pattern)
     (let ((existing (assoc pattern binds)))
       (if existing
           ;; Already bound --- the value must match datum
           (match (cdr existing) datum binds)
           ;; Unbound --- extend bindings
           (cons (cons pattern datum) binds))))
    ;; Recurse through cons cells
    ((and (consp pattern) (consp datum))
     (match (cdr pattern) (cdr datum)
            (match (car pattern) (car datum) binds)))
    ;; No match
    (t :fail)))

;;; ------ Substitution ------------------------------------------------------------------------------------------------------------------------------------
;;; Walk a template LIST, replacing each variable with its binding.
(defun subs (lst binds)
  (cond
    ((null lst) nil)
    ((atom lst)
     (let ((b (assoc lst binds)))
       (if b (cdr b) lst)))
    (t (cons (subs (car lst) binds)
             (subs (cdr lst) binds)))))

;;; ------ Simple (primitive) query ------------------------------------------------------------------------------------------------
;;; Match PATTERN against every fact in *db*; collect bindings.
(defun query-simple (pattern binds)
  (let ((results nil))
    (dolist (fact *db* results)
      (let ((b (match pattern fact binds)))
        (unless (eq b :fail)
          (push b results))))))

;;; ------ AND  (conjunction) ------------------------------------------------------------------------------------------------------------------
;;; Thread a list of binding-sets through each sub-query in turn.
(defun query-and (exprs bind-list)
  (if (null exprs)
      bind-list
      (query-and (cdr exprs)
                 (mapcan (lambda (binds)
                           (query (car exprs) binds))
                         bind-list))))

;;; ------ OR  (disjunction) ---------------------------------------------------------------------------------------------------------------------
;;; Collect results from every branch.
(defun query-or (exprs binds)
  (mapcan (lambda (expr) (query expr binds)) exprs))

;;; ------ NOT  (negation-as-failure) ------------------------------------------------------------------------------------------
;;; Succeed (returning current binds) only when sub-query fails.
(defun query-not (expr binds)
  (if (null (query expr binds))
      (list binds)
      nil))

;;; ------ TEST  (Lisp predicate) ------------------------------------------------------------------------------------------------------
;;; Substitute bindings into EXPR, then evaluate it.
;;; Use (quote ?var) inside the expression when the bound value
;;; is itself a list, to prevent CL from evaluating it as a call.
(defun query-test (expr binds)
  (if (eval (subs expr binds))
      (list binds)
      nil))

;;; ------ Main dispatcher ---------------------------------------------------------------------------------------------------------------------------
(defun query (expr binds)
  "Run a query expression against *db* with initial BINDS.
Returns a list of binding alists (one per successful match)."
  (cond
    ((eq (car expr) 'and)  (query-and  (cdr expr) (list binds)))
    ((eq (car expr) 'or)   (query-or   (cdr expr) binds))
    ((eq (car expr) 'not)  (query-not  (cadr expr) binds))
    ((eq (car expr) 'test) (query-test (cadr expr) binds))
    (t                     (query-simple expr binds))))

;;; ------ Pretty-print results ------------------------------------------------------------------------------------------------------------
(defun answer (label expr output)
  "Run EXPR query; for each result print items in OUTPUT template.
LABEL is a string header printed before results."
  (format t "~%~A~%" label)
  (let ((results (query expr nil)))
    (if (null results)
        (format t "  (no results)~%")
        (dolist (binds results)
          (format t "  ")
          (mapc (lambda (p)
                  (let ((val (subs p binds)))
                    (if (stringp val)
                        (format t "~A " val)
                        (format t "~S " val))))
                output)
          (terpri)))))


;;; ============================================================
;;; PART 2 --- TRIPLE STORE INTERFACE
;;; ============================================================

;;; Each triple is stored as a 4-element list:
;;;   (triple SUBJECT PREDICATE OBJECT)
;;;
;;; assert-triple quotes all three arguments, so you write them
;;; as bare symbols and lists without needing explicit quotes.

(defmacro assert-triple (subject predicate object)
  "Add (triple SUBJECT PREDICATE OBJECT) to the database."
  `(add-fact 'triple ',subject ',predicate ',object))


;;; ============================================================
;;; PART 3 --- MICROSHAFT PERSONNEL DATABASE  (SICP -- 4.4.1)
;;;
;;; Original form:  (job (Bitdiddle Ben) (computer wizard))
;;; SPO form:       subject=bitdiddle-ben  pred=job  obj=(computer wizard)
;;;
;;; Subjects are flat symbol identifiers.  A 'name triple holds
;;; the canonical display name as used in the SICP text.
;;;
;;; Predicates used:
;;;   name       --- display name list  e.g. (Bitdiddle Ben)
;;;   job        --- job title list     e.g. (computer wizard)
;;;   salary     --- integer USD salary
;;;   address    --- address list
;;;   supervisor --- subject-ID of direct manager
;;; ============================================================

;;; ------ Ben Bitdiddle --- computer wizard ---------------------------------------------------------------------------
(assert-triple bitdiddle-ben  name        (Bitdiddle Ben))
(assert-triple bitdiddle-ben  job         (computer wizard))
(assert-triple bitdiddle-ben  salary      60000)
(assert-triple bitdiddle-ben  address     (Slumerville (Ridge Road) 10))
(assert-triple bitdiddle-ben  supervisor  warbucks-oliver)

;;; ------ Alyssa P. Hacker --- computer programmer ------------------------------------------------------
(assert-triple hacker-alyssa-p  name        (Hacker Alyssa P))
(assert-triple hacker-alyssa-p  job         (computer programmer))
(assert-triple hacker-alyssa-p  salary      40000)
(assert-triple hacker-alyssa-p  address     (Cambridge (Mass Ave) 78))
(assert-triple hacker-alyssa-p  supervisor  bitdiddle-ben)

;;; ------ Cy D. Fect --- computer programmer ------------------------------------------------------------------------
(assert-triple fect-cy-d  name        (Fect Cy D))
(assert-triple fect-cy-d  job         (computer programmer))
(assert-triple fect-cy-d  salary      35000)
(assert-triple fect-cy-d  address     (Cambridge (Ames Street) 3))
(assert-triple fect-cy-d  supervisor  bitdiddle-ben)

;;; ------ Lem E. Tweakit --- computer technician ------------------------------------------------------------
(assert-triple tweakit-lem-e  name        (Tweakit Lem E))
(assert-triple tweakit-lem-e  job         (computer technician))
(assert-triple tweakit-lem-e  salary      25000)
(assert-triple tweakit-lem-e  address     (Boston (Bay State Road) 22))
(assert-triple tweakit-lem-e  supervisor  bitdiddle-ben)

;;; ------ Louis Reasoner --- computer programmer trainee ---------------------------------------
(assert-triple reasoner-louis  name        (Reasoner Louis))
(assert-triple reasoner-louis  job         (computer programmer trainee))
(assert-triple reasoner-louis  salary      30000)
(assert-triple reasoner-louis  address     (Slumerville (Pine Tree Road) 80))
(assert-triple reasoner-louis  supervisor  hacker-alyssa-p)

;;; ------ Oliver Warbucks --- administration big wheel ---------------------------------------------
(assert-triple warbucks-oliver  name     (Warbucks Oliver))
(assert-triple warbucks-oliver  job      (administration big wheel))
(assert-triple warbucks-oliver  salary   150000)
(assert-triple warbucks-oliver  address  (Swellesley (Top Heap Road)))
;;; Warbucks has no supervisor triple --- he is the top of the hierarchy.

;;; ------ Eben Scrooge --- accounting chief accountant ---------------------------------------------
(assert-triple scrooge-eben  name        (Scrooge Eben))
(assert-triple scrooge-eben  job         (accounting chief accountant))
(assert-triple scrooge-eben  salary      75000)
(assert-triple scrooge-eben  address     (Weston (Shady Lane) 10))
(assert-triple scrooge-eben  supervisor  warbucks-oliver)

;;; ------ Robert Cratchet --- accounting scrivener ---------------------------------------------------------
(assert-triple cratchet-robert  name        (Cratchet Robert))
(assert-triple cratchet-robert  job         (accounting scrivener))
(assert-triple cratchet-robert  salary      18000)
(assert-triple cratchet-robert  address     (Allston (N Harvard Street) 16))
(assert-triple cratchet-robert  supervisor  scrooge-eben)

;;; ------ DeWitt Aull --- administration secretary ---------------------------------------------------------
(assert-triple aull-dewitt  name        (Aull DeWitt))
(assert-triple aull-dewitt  job         (administration secretary))
(assert-triple aull-dewitt  salary      25000)
(assert-triple aull-dewitt  address     (Slumerville (Onion Square) 5))
(assert-triple aull-dewitt  supervisor  warbucks-oliver)

;;; ------ Job-capability triples ---------------------------------------------------------------------------------------------------------
;;; (can-do-job JOB1 JOB2) means a holder of JOB1 can also do JOB2.
;;; Here the "subject" is itself a list (a job title).
(assert-triple (computer wizard)         can-do-job  (computer programmer))
(assert-triple (computer wizard)         can-do-job  (computer technician))
(assert-triple (computer programmer)     can-do-job  (computer programmer trainee))
(assert-triple (administration secretary) can-do-job (administration big wheel))


;;; ============================================================
;;; PART 4 --- EXAMPLE QUERIES
;;; ============================================================

(format t "~%~%====================================================")
(format t "~%   MICROSHAFT SPO TRIPLE STORE  -  QUERY EXAMPLES  ")
(format t "~%====================================================~%")

;;; ------ Q1  Simple lookup: who are the computer programmers? ------------
(answer "Q1  All computer programmers"
        '(triple ?person job (computer programmer))
        '(?person))

;;; ------ Q2  All jobs (every person's job title) ---------------------------------------------------
(answer "Q2  Everyone's job"
        '(triple ?person job ?title)
        '(?person "->" ?title))

;;; ------ Q3  All salaries ---------------------------------------------------------------------------------------------------------------------------
(answer "Q3  All salaries"
        '(triple ?person salary ?amount)
        '(?person "earns $" ?amount))

;;; ------ Q4  TEST: who earns more than $40,000? ---------------------------------------------------------
;;; (test EXPR) evaluates EXPR with variables substituted.
;;; Simple numeric comparisons work directly.
(answer "Q4  Earning more than $40,000  (test combinator)"
        '(and (triple ?person salary ?s)
              (test (> ?s 40000)))
        '(?person "  $" ?s))

;;; ------ Q5  JOIN: supervisor + salary in one result ---------------------------------------
;;; Classic 2-triple join: the ?person variable links both triples.
(answer "Q5  Ben Bitdiddle's direct reports with their salaries  (join)"
        '(and (triple ?person supervisor bitdiddle-ben)
              (triple ?person salary ?s))
        '(?person "  $" ?s))

;;; ------ Q6  JOIN + TEST: who earns less than their supervisor? ------
;;; Three-triple join threads ?person, ?boss, ?ps, ?bs.
(answer "Q6  People who earn less than their own supervisor  (3-triple join + test)"
        '(and (triple ?person supervisor ?boss)
              (triple ?person salary ?ps)
              (triple ?boss salary ?bs)
              (test (< ?ps ?bs)))
        '(?person "($" ?ps ") < " ?boss "($" ?bs ")"))

;;; ------ Q7  Two-hop chain: grandparent in org chart ------------------------------------------
;;; ?person --- ?mid-mgr --- warbucks-oliver
(answer "Q7  Everyone whose boss reports to Oliver Warbucks  (2-hop chain)"
        '(and (triple ?person supervisor ?mid)
              (triple ?mid supervisor warbucks-oliver))
        '(?person "supervised by" ?mid))

;;; ------ Q8  OR: computer programmers OR computer technicians ---------------
(answer "Q8  Computer programmers or technicians  (or combinator)"
        '(or (triple ?person job (computer programmer))
             (triple ?person job (computer technician)))
        '(?person))

;;; ------ Q9  NOT: people with a supervisor, but not Ben's reports ---
(answer "Q9  Have a supervisor but are NOT Ben's direct reports  (not combinator)"
        '(and (triple ?person supervisor ?boss)
              (not (triple ?person supervisor bitdiddle-ben)))
        '(?person "--- boss:" ?boss))

;;; ------ Q10 JOIN names for display ---------------------------------------------------------------------------------------------
;;; Join ?id --- name triple to get the SICP-style display name.
(answer "Q10 Computer division staff with display names  (name-join)"
        '(and (triple ?id job ?j)
              (test (equal (car (quote ?j)) (quote computer)))
              (triple ?id name ?n))
        '(?n "--" ?j))

;;; ------ Q11 Can-do-job lookup ------------------------------------------------------------------------------------------------------------
;;; Demonstrate that non-person subjects work equally well.
(answer "Q11 What jobs can a computer wizard do?  (capability triples)"
        '(triple (computer wizard) can-do-job ?other-job)
        '("computer wizard can cover:" ?other-job))

;;; ------ Q12 Slumerville residents ------------------------------------------------------------------------------------------------
;;; Pattern-match the FIRST element of a list object.
;;; (address (Slumerville ...)) --- the object starts with SLUMERVILLE.
(answer "Q12 Slumerville residents  (nested-list pattern matching)"
        '(triple ?person address (Slumerville . ?rest))
        '(?person "lives at" (Slumerville . ?rest)))

;;; ------ Q13 Cross-product salary comparison ------------------------------------------------------------------
;;; Find all pairs where person-A earns strictly less than person-B.
;;; (This produces many rows --- demonstrates cross-product joins.)
(answer "Q13 All (A, B) pairs where A earns less than B  (cross-product)"
        '(and (triple ?a salary ?sa)
              (triple ?b salary ?sb)
              (test (< ?sa ?sb))
              (test (not (eq (quote ?a) (quote ?b)))))
        '(?a "($" ?sa ") < " ?b "($" ?sb ")"))

(format t "~%Done.~%")
