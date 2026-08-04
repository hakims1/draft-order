// Stripe payments. Two one-time SKUs, no subscriptions.
//
// The whole module is inert until STRIPE_SECRET_KEY is set: the SDK is loaded
// by dynamic import inside the accessor, so a function deployed without keys
// never pulls the npm specifier at all and cannot fail to boot because of it.
// Callers use `stripeEnabled()` to decide between real checkout and the mock
// grant that carried the product before payments existed.

import sql from "./db.ts";
import { PRICES } from "./logic.ts";

export const stripeEnabled = () => !!Deno.env.get("STRIPE_SECRET_KEY");

let _mod: any = null;
let _client: any = null;

async function stripeMod() {
  if (!_mod) _mod = await import("npm:stripe@17.7.0");
  return _mod.default;
}

export async function getStripe() {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  if (_client) return _client;
  const Stripe = await stripeMod();
  _client = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  return _client;
}

// Checkout line items are built inline from PRICES, so there is nothing to
// configure in the Stripe dashboard and one price constant stays authoritative.
export const SKU_INFO: Record<string, { name: string; description: string; price: number }> = {
  ultimate: {
    name: "Ultimate — The Proving Ground",
    description:
      "Leagues of any size, the Skill & Wit Combine, and the organizer answer key. One payment, covers your account.",
    price: PRICES.ultimate,
  },
  answer_key: {
    name: "Answer Key — The Proving Ground",
    description:
      "Every question you missed and every question your league missed, for this competition.",
    price: PRICES.answer_key,
  },
};

// ---------- granting ----------

type GrantInput = {
  sku: string;
  adminId?: string | null;
  competitionId?: string | null;
  participantId?: string | null;
  sessionId?: string | null;
  paymentIntent?: string | null;
  amountCents?: number | null;
  email?: string | null;
  source?: string;
};

// The single path to an entitlement, used by the webhook, by the return-path
// confirmation, and by the pre-Stripe mock. Idempotent on the natural keys:
// a replayed webhook updates the same row instead of erroring or duplicating.
// A re-purchase after a refund clears revoked_at, which is why this is an
// upsert rather than an insert-if-absent.
export async function grantEntitlement(p: GrantInput): Promise<boolean> {
  const source = p.source ?? "stripe";
  if (p.sessionId) {
    const seen = await sql`
      select 1 from entitlements
      where stripe_session_id = ${p.sessionId} and revoked_at is null`;
    if (seen.length) return true; // already processed
  }

  if (p.sku === "ultimate") {
    if (!p.adminId) return false;
    await sql`
      insert into entitlements
        (sku, admin_id, source, stripe_session_id, stripe_payment_intent,
         amount_cents, buyer_email, buyer_admin_id)
      values ('ultimate', ${p.adminId}, ${source}, ${p.sessionId ?? null},
              ${p.paymentIntent ?? null}, ${p.amountCents ?? null},
              ${p.email ?? null}, ${p.adminId})
      on conflict (admin_id, sku) where sku = 'ultimate' do update set
        revoked_at = null,
        source = excluded.source,
        stripe_session_id = coalesce(excluded.stripe_session_id, entitlements.stripe_session_id),
        stripe_payment_intent = coalesce(excluded.stripe_payment_intent, entitlements.stripe_payment_intent),
        amount_cents = coalesce(excluded.amount_cents, entitlements.amount_cents),
        buyer_email = coalesce(excluded.buyer_email, entitlements.buyer_email)`;
    return true;
  }

  if (p.sku === "answer_key") {
    if (!p.participantId || !p.competitionId) return false;
    await sql`
      insert into entitlements
        (sku, competition_id, granted_to_participant_id, source, stripe_session_id,
         stripe_payment_intent, amount_cents, buyer_email, buyer_admin_id)
      values ('answer_key', ${p.competitionId}, ${p.participantId}, ${source},
              ${p.sessionId ?? null}, ${p.paymentIntent ?? null}, ${p.amountCents ?? null},
              ${p.email ?? null}, ${p.adminId ?? null})
      on conflict (granted_to_participant_id, sku) where sku = 'answer_key' do update set
        revoked_at = null,
        source = excluded.source,
        stripe_session_id = coalesce(excluded.stripe_session_id, entitlements.stripe_session_id),
        stripe_payment_intent = coalesce(excluded.stripe_payment_intent, entitlements.stripe_payment_intent),
        amount_cents = coalesce(excluded.amount_cents, entitlements.amount_cents),
        buyer_email = coalesce(excluded.buyer_email, entitlements.buyer_email),
        buyer_admin_id = coalesce(excluded.buyer_admin_id, entitlements.buyer_admin_id)`;
    return true;
  }
  return false;
}

// Refund or dispute: the entitlement goes away. Checks read revoked_at, so
// access stops on the next request without deleting the payment trail.
export async function revokeByPaymentIntent(pi: string): Promise<number> {
  const rows = await sql`
    update entitlements set revoked_at = now()
    where stripe_payment_intent = ${pi} and revoked_at is null
    returning id`;
  return rows.length;
}

// ---------- checkout ----------

export async function createCheckoutSession(opts: {
  sku: string;
  site: string;
  returnHash: string; // where the buyer lands afterwards, e.g. "/c/<token>"
  adminId?: string | null;
  competitionId?: string | null;
  participantId?: string | null;
  email?: string | null;
}): Promise<string | null> {
  const stripe = await getStripe();
  const info = SKU_INFO[opts.sku];
  if (!stripe || !info) return null;

  // Query string before the fragment: the hash router never sees pg_checkout,
  // and the SPA reads it from location.search on boot to confirm the payment.
  const base = opts.site.replace(/\/$/, "/");
  const success = `${base}?pg_checkout={CHECKOUT_SESSION_ID}#${opts.returnHash}`;
  const cancel = `${base}#${opts.returnHash}`;

  const metadata: Record<string, string> = { sku: opts.sku };
  if (opts.adminId) metadata.admin_id = opts.adminId;
  if (opts.competitionId) metadata.competition_id = opts.competitionId;
  if (opts.participantId) metadata.participant_id = opts.participantId;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: Math.round(info.price * 100),
        product_data: { name: info.name, description: info.description },
      },
    }],
    success_url: success,
    cancel_url: cancel,
    customer_email: opts.email || undefined,
    allow_promotion_codes: true,
    metadata,
    payment_intent_data: { metadata },
  });
  return session.url ?? null;
}

// Grant from a Checkout Session object (shared by webhook and return path).
async function grantFromSession(session: any): Promise<{ granted: boolean; sku?: string }> {
  if (session?.payment_status !== "paid") return { granted: false };
  const m = session.metadata ?? {};
  const pi = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
  const granted = await grantEntitlement({
    sku: String(m.sku ?? ""),
    adminId: m.admin_id ?? null,
    competitionId: m.competition_id ?? null,
    participantId: m.participant_id ?? null,
    sessionId: session.id,
    paymentIntent: pi,
    amountCents: session.amount_total ?? null,
    email: session.customer_details?.email ?? session.customer_email ?? null,
  });
  return { granted, sku: m.sku };
}

// Return-path fallback. The webhook is the source of truth, but a buyer who
// lands back on the site before it arrives would otherwise see a locked
// feature they just paid for; this retrieves the session directly and grants
// through the same idempotent path.
export async function confirmSession(sessionId: string) {
  const stripe = await getStripe();
  if (!stripe) return { ok: false as const, error: "not configured" };
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const r = await grantFromSession(session);
  return { ok: true as const, paid: session.payment_status === "paid", ...r };
}

// ---------- webhook ----------

export async function handleWebhook(rawBody: string, signature: string) {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const stripe = await getStripe();
  if (!stripe || !secret) return { status: 503, body: { error: "not configured" } };

  const Stripe = await stripeMod();
  let event: any;
  try {
    // Deno has no synchronous crypto: verification must use the async form
    // with the SubtleCrypto provider.
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (e) {
    console.error("stripe signature verification failed:", e instanceof Error ? e.message : e);
    return { status: 400, body: { error: "bad signature" } };
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const r = await grantFromSession(event.data.object);
      return { status: 200, body: { received: true, granted: r.granted } };
    }
    case "charge.refunded":
    case "charge.dispute.created": {
      const obj = event.data.object;
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      const n = pi ? await revokeByPaymentIntent(pi) : 0;
      return { status: 200, body: { received: true, revoked: n } };
    }
    default:
      return { status: 200, body: { received: true, ignored: event.type } };
  }
}
