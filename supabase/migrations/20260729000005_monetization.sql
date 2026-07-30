-- Monetization infrastructure: config-driven paywall gates, A/B experiment
-- assignment, entitlements, and funnel events. No gate is active by default —
-- shipping this changes nothing user-visible until app_config is edited.

create table app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Gate modes:
--   "open"        everyone passes (current state for all gates)
--   "paid"        requires an entitlement
--   "experiment"  variant-dependent: admins bucketed into `paywalled_variants`
--                 hit the paywall unless entitled; other variants pass
insert into app_config (key, value) values ('monetization', '{
  "experiments": {
    "paywall_placement_v1": {
      "enabled": false,
      "salt": "pp1",
      "variants": ["gate_at_activation", "upsell_later"]
    }
  },
  "gates": {
    "activate_wonderlic": {
      "mode": "open",
      "experiment": "paywall_placement_v1",
      "paywalled_variants": ["gate_at_activation"]
    },
    "missed_review": {
      "mode": "open",
      "experiment": "paywall_placement_v1",
      "paywalled_variants": ["upsell_later"]
    }
  },
  "paywall_copy": {
    "activate_wonderlic": {
      "title": "Unlock the Wonderlic test",
      "message": "Running a timed cognitive test for your league is a premium feature. The random-order draw is always free.",
      "cta": "Upgrade to launch"
    },
    "missed_review": {
      "title": "See what you missed",
      "message": "Your commissioner can unlock the answer-key review for the whole league.",
      "cta": "Unlock answer keys"
    }
  }
}'::jsonb);

-- Sticky per-admin experiment assignment (bucketed once, stable thereafter).
create table admin_experiments (
  admin_id uuid not null references admins(id) on delete cascade,
  experiment text not null,
  variant text not null,
  assigned_at timestamptz not null default now(),
  primary key (admin_id, experiment)
);

-- What an admin has paid for (or been granted). null expires_at = lifetime.
create table entitlements (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admins(id) on delete cascade,
  product text not null default 'pro',
  source text,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (admin_id, product)
);

-- Funnel events for experiment analysis.
create table events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  admin_id uuid,
  competition_id uuid,
  participant_id uuid,
  props jsonb not null default '{}'::jsonb
);
create index events_name_time_idx on events (name, created_at);
create index events_admin_idx on events (admin_id);
