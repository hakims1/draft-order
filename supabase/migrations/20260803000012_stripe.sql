-- Stripe payments. Entitlements gain a payment trail so purchases can be
-- reconciled against Stripe, receipted, and revoked when a charge is refunded
-- or disputed. Grants stay idempotent on the natural keys (one ultimate per
-- account, one answer key per seat); the session/payment-intent columns exist
-- for lookup and revocation, deliberately NOT unique — a duplicate webhook
-- must be a no-op, never a constraint error that 500s the endpoint.

alter table entitlements
  add column if not exists stripe_session_id text,
  add column if not exists stripe_payment_intent text,
  add column if not exists amount_cents int,
  add column if not exists buyer_email text,
  add column if not exists buyer_admin_id uuid references admins(id) on delete set null,
  add column if not exists revoked_at timestamptz;

create index if not exists entitlements_session_idx
  on entitlements (stripe_session_id) where stripe_session_id is not null;
create index if not exists entitlements_pi_idx
  on entitlements (stripe_payment_intent) where stripe_payment_intent is not null;

-- Every existing row predates payments and is a live mock grant.
update entitlements set revoked_at = null where revoked_at is not null;
