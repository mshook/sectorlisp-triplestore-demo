(DEFINE ASSOC .
  (LAMBDA (X Y)
    (COND ((EQ Y NIL) (QUOTE *UNDEFINED))
          ((EQ X (CAR (CAR Y))) (CDR (CAR Y)))
          ((QUOTE T) (ASSOC X (CDR Y))))))

(DEFINE EVCON .
  (LAMBDA (C A)
    (COND ((EVAL (CAR (CAR C)) A)
           (EVAL (CAR (CDR (CAR C))) A))
          ((QUOTE T) (EVCON (CDR C) A)))))

(DEFINE PAIRLIS .
  (LAMBDA (X Y A)
    (COND ((EQ X NIL) A)
          ((QUOTE T) (CONS (CONS (CAR X) (CAR Y))
                           (PAIRLIS (CDR X) (CDR Y) A))))))

(DEFINE EVLIS .
  (LAMBDA (M A)
    (COND ((EQ M NIL) M)
          ((QUOTE T) (CONS (EVAL (CAR M) A)
                           (EVLIS (CDR M) A))))))

(DEFINE APPLY .
  (LAMBDA (FN X A)
    (COND
      ((ATOM FN)
       (COND ((EQ FN (QUOTE CAR))  (CAR  (CAR X)))
             ((EQ FN (QUOTE CDR))  (CDR  (CAR X)))
             ((EQ FN (QUOTE ATOM)) (ATOM (CAR X)))
             ((EQ FN (QUOTE CONS)) (CONS (CAR X) (CAR (CDR X))))
             ((EQ FN (QUOTE EQ))   (EQ   (CAR X) (CAR (CDR X))))
             ((QUOTE T)            (APPLY (EVAL FN A) X A))))
      ((EQ (CAR FN) (QUOTE LAMBDA))
       (EVAL (CAR (CDR (CDR FN)))
             (PAIRLIS (CAR (CDR FN)) X A))))))

(DEFINE EVAL .
  (LAMBDA (E A)
    (COND
      ((ATOM E)
       (COND ((EQ E NIL) E)
             ((EQ E (QUOTE T)) (QUOTE T))
             ((QUOTE T) (ASSOC E A))))
      ((ATOM (CAR E))
       (COND ((EQ (CAR E) (QUOTE QUOTE)) (CAR (CDR E)))
             ((EQ (CAR E) (QUOTE COND)) (EVCON (CDR E) A))
             ((EQ (CAR E) (QUOTE LAMBDA)) E)
             ((QUOTE T) (APPLY (CAR E) (EVLIS (CDR E) A) A))))
      ((QUOTE T) (APPLY (CAR E) (EVLIS (CDR E) A) A)))))

(EVAL (QUOTE ((LAMBDA (FF X)
                (FF X))
              (LAMBDA (X)
                (COND ((ATOM X) X)
                      (T (FF (CAR X)))))
              (QUOTE ((A) B C))))
      NIL)
