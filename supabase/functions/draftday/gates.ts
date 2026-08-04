import sql from "./db.ts";

// ---------------------------------------------------------------------------
// Config-driven paywall gates + A/B experiments + funnel events.
//
// A "gate" is a named trigger point in the product (e.g. "activate_wonderlic").
// Its behavior lives in the app_config row 'monetization', so experiments can
// be turned on/off with a single SQL update — no redeploy:
//
//   update app_config set value = jsonb_set(value,
//     '{gates,activate_wonderlic,mode}', '"experiment"'), updated_at = now()
//   where key = 'monetization';
//   update app_config set value = jsonb_set(value,
//     '{experiments,paywall_placement_v1,enabled}', 'true'), updated_at = now()
//   where key = 'monetization';
// ---------------------------------------------------------------------------

const cache = new Map<string, { value: any; at: number }>();

export async function configValue(key: string) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const rows = await sql`select value from app_config where key = ${key}`;
  const value = rows[0]?.value ?? {};
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function monetizationConfig() {
  return await configValue("monetization");
}

export async function isOwner(email: string): Promise<boolean> {
  const app = await configValue("app");
  return (app.owner_emails ?? []).includes(email);
}

// Fire-and-forget funnel event. Never throws into the request path.
export async function logEvent(
  name: string,
  ids: { adminId?: string; competitionId?: string; participantId?: string; props?: Record<string, unknown> } = {},
) {
  try {
    await sql`
      insert into events (name, admin_id, competition_id, participant_id, props)
      values (${name}, ${ids.adminId ?? null}, ${ids.competitionId ?? null},
              ${ids.participantId ?? null}, ${sql.json(ids.props ?? {})})`;
  } catch (e) {
    console.error("event log failed:", e);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export async function hasEntitlement(adminId: string, sku = "ultimate"): Promise<boolean> {
  if (!adminId) return false;
  const rows = await sql`
    select 1 from entitlements
    where admin_id = ${adminId} and sku = ${sku} and revoked_at is null`;
  return rows.length > 0;
}

// Sticky variant: hash-bucketed on first touch, persisted so later config
// edits (adding variants, changing salt) never reshuffle existing admins.
export async function experimentVariant(adminId: string, experiment: string): Promise<string | null> {
  const cfg = await monetizationConfig();
  const exp = cfg.experiments?.[experiment];
  if (!exp?.enabled || !exp.variants?.length) return null;
  const existing = await sql`
    select variant from admin_experiments
    where admin_id = ${adminId} and experiment = ${experiment}`;
  if (existing.length) return existing[0].variant;
  const variant = exp.variants[fnv1a(`${adminId}:${exp.salt ?? experiment}`) % exp.variants.length];
  await sql`
    insert into admin_experiments (admin_id, experiment, variant)
    values (${adminId}, ${experiment}, ${variant})
    on conflict (admin_id, experiment) do nothing`;
  await logEvent("experiment_assigned", { adminId, props: { experiment, variant } });
  return variant;
}

export type GateResult =
  | { open: true; variant: string | null }
  | { open: false; variant: string | null; paywall: { gate: string; title: string; message: string; cta: string; experiment: string | null; variant: string | null } };

// Decide whether `adminId` passes the named gate. `log: false` for gates that
// sit on polled endpoints, so events stay one-per-meaningful-action.
export async function checkGate(
  gate: string,
  adminId: string,
  opts: { log?: boolean; competitionId?: string } = {},
): Promise<GateResult> {
  const cfg = await monetizationConfig();
  const g = cfg.gates?.[gate];
  const mode = g?.mode ?? "open";
  let open = true;
  let experiment: string | null = null;
  let variant: string | null = null;

  if (mode === "paid") {
    open = await hasEntitlement(adminId);
  } else if (mode === "experiment" && g?.experiment) {
    experiment = g.experiment;
    variant = await experimentVariant(adminId, g.experiment);
    if (variant && (g.paywalled_variants ?? []).includes(variant)) {
      open = await hasEntitlement(adminId);
    }
  }

  if (opts.log !== false) {
    await logEvent("gate_hit", {
      adminId,
      competitionId: opts.competitionId,
      props: { gate, mode, open, experiment, variant },
    });
  }
  if (open) return { open: true, variant };

  const copy = cfg.paywall_copy?.[gate] ?? {};
  return {
    open: false,
    variant,
    paywall: {
      gate,
      title: copy.title ?? "Premium feature",
      message: copy.message ?? "This feature requires an upgrade.",
      cta: copy.cta ?? "Upgrade",
      experiment,
      variant,
    },
  };
}
