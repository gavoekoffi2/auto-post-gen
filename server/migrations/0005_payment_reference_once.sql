-- =====================================================================
-- 0005 — A Mobile Money reference can be declared only once. Ever.
--
-- Product rule: « Une même référence Mobile Money ne doit jamais servir deux
-- fois. » 0003 only enforced it among pending and approved declarations, so a
-- reference came back into circulation once its declaration was rejected or
-- cancelled. It no longer does, whatever the status: after a typo, the
-- operator rejects with a reason and the customer declares a NEW reference.
--
-- The key is the reference's canonical form — every whitespace removed,
-- upper-cased — and it is global rather than per payment method, so
-- " mp2309.01 ", "MP 2309.01" and "MP2309.01" are one reference, and the
-- same transaction id cannot be re-declared under another channel. The API
-- stores references in that canonical form already (services/subscriptions.ts
-- canonicalReference); the index enforces it for any writer.
--
-- 0003's narrower index is left in place (it is implied by this one and
-- removing it would gain nothing). Nothing is dropped or deleted. Idempotent.
-- =====================================================================

DO $reference$
DECLARE
  dup_count bigint;
  dup_sample text;
BEGIN
  IF to_regclass('public.subscription_requests_reference_once') IS NOT NULL THEN RETURN; END IF;

  -- Refuse rather than guess: if two declarations already share a reference,
  -- someone must decide which one is legitimate before the rule can hold.
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM subscription_requests
     GROUP BY upper(regexp_replace(payment_reference, '\s', '', 'g')) HAVING count(*) > 1
  ) d;
  SELECT string_agg(ref, ', ') INTO dup_sample FROM (
    SELECT upper(regexp_replace(payment_reference, '\s', '', 'g')) AS ref
      FROM subscription_requests
     GROUP BY 1 HAVING count(*) > 1
     ORDER BY 1 LIMIT 10
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s payment reference(s) are already declared more than once.', dup_count),
      DETAIL  = format('References (up to 10): %s', dup_sample),
      HINT    = 'SELECT id, profile_id, status, payment_reference, created_at FROM subscription_requests '
                'WHERE upper(regexp_replace(payment_reference, ''\s'', '''', ''g'')) = ''<ref>''; '
                'decide which declaration is legitimate, then migrate again. Nothing was written.';
  END IF;

  CREATE UNIQUE INDEX subscription_requests_reference_once
    ON subscription_requests (upper(regexp_replace(payment_reference, '\s', '', 'g')));
END;
$reference$;
