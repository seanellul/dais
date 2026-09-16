-- Custom SQL migration file, put your code below! -----

-- The audit log is append-only. Nothing in the app updates or deletes audit
-- rows, and this trigger makes sure nothing outside the app can either
-- (except a superuser who first drops the trigger, which is itself visible).
CREATE OR REPLACE FUNCTION audit_log_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_change();
