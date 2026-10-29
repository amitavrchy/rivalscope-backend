CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Organization" ADD CONSTRAINT "organization_credit_invariants"
  CHECK ("credits" >= 0 AND "reservedCredits" >= 0 AND "reservedCredits" <= "credits");
ALTER TABLE "ResearchRun" ADD CONSTRAINT "run_credit_invariants"
  CHECK ("reservedCredits" > 0 AND "consumedCredits" >= 0 AND "consumedCredits" <= "reservedCredits");

CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable accounting/audit records cannot be changed or deleted';
END;
$$;

CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE OR DELETE ON "CreditLedger"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
