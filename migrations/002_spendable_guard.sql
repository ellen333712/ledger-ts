-- ledger-ts · 002_spendable_guard.sql
-- Asset accounts (normal_side DEBIT) are the spendable ones: their balance
-- may never go negative. Enforced here, not in application folklore; the
-- engine's guarded UPSERT is the fast path, this trigger is the backstop.

CREATE FUNCTION assert_spendable_non_negative() RETURNS trigger AS $$
DECLARE
  v_type TEXT;
BEGIN
  SELECT account_type INTO v_type
    FROM ledger_account
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id;
  IF v_type = 'asset' AND NEW.amount < 0 THEN
    RAISE EXCEPTION 'NON_NEGATIVE_BALANCE: account % would go to %', NEW.account_id, NEW.amount;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER spendable_non_negative
  AFTER INSERT OR UPDATE ON account_balance
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_spendable_non_negative();
