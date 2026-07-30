# Draft Order Competition

A mobile-first web app that decides fantasy draft order with a real contest instead of
a coin flip. League members open a shared link on their phone, enter a name, and compete.
Highest rank gets the first pick.

**Live app:** https://hakims1.github.io/draft-order/

Two competition types ship in v1:

- **`wonderlic`** — a 30-question, 6-minute timed cognitive test (original questions,
  Wonderlic-style format). Score descending, ties broken by elapsed time ascending.
- **`random_order`** — everyone enters a name; when the last slot fills, the order is
  drawn server-side exactly once and revealed with an animation.

## Architecture

| Piece | Tech | Where |
|---|---|---|
| Frontend | Static SPA (vanilla JS, hash routing) | GitHub Pages, served from `docs/` on `main` |
| API | Deno + Hono edge function `draftday` | Supabase Edge Functions |
| Database | Postgres 17 | Supabase project `bwxsuybqhgocmwncxzlz` |

Why not Next.js/Vercel: Supabase blocks HTML responses from `*.supabase.co` (anti-phishing),
and this stack needed zero new accounts — the Supabase CLI and GitHub CLI were already
authenticated. GitHub Pages hosts the shell; every state-changing or clock-sensitive
operation lives in the edge function.

**Timing is server-authoritative.** `started_at` and `deadline_at` are stamped in Postgres
when the member presses Start. Every request re-validates against the DB clock; late
submissions finalize the attempt instead of scoring. The client countdown is display-only
and re-syncs on every response. Identity is a per-participant token in `localStorage`
(header `x-pt`), so force-quitting the browser and reopening the link resumes the attempt
with the elapsed time burned.

## Repo layout

```
docs/                       # the SPA (index.html, app.js, app.css) — GitHub Pages root
supabase/
  config.toml
  functions/draftday/
    index.ts                # routes: member flow, results, admin API, CORS
    logic.ts                # join/start/answer/finalize, shuffling, ranking, close
    auth.ts                 # admin password hashing (PBKDF2) + sessions
    db.ts                   # postgres.js client + token generator
  migrations/
    ..._init.sql            # schema
    ..._seed_questions.sql  # 30-question bank (bank_version 1)
    ..._keepalive.sql       # pg_cron self-ping so the free-tier project never pauses
```

## Data model (the short version)

`admins → leagues → competitions → participants → attempts`

- `competitions.config` (jsonb) holds all type-specific settings
  (`{bank_version, question_count, time_limit_seconds, max_attempts}` for wonderlic).
  No type-specific columns anywhere.
- `attempts` stores generic `score` (numeric) + `duration_ms` (int); per-type working
  data (question order, option orders, answers) lives in `attempts.state` (jsonb).
  `attempt_number` + config `max_attempts` are wired for best-of-N later (logic is
  hardcoded to 1 today).
- `participants.join_token` is reserved for future per-member single-use invite links.
- `participants.shuffle_seed` makes each player's question/option shuffle reproducible.
- Share and results tokens are 18 random bytes, base64url.

## Local development

Prereqs: [Supabase CLI](https://supabase.com/docs/guides/cli), `psql`, any static file
server, and a Supabase project (or `supabase start` for a fully local stack).

```bash
# 1. Apply migrations (session pooler, port 5432)
psql "$DB_URL" -f supabase/migrations/20260727000001_init.sql
psql "$DB_URL" -f supabase/migrations/20260727000002_seed_questions.sql

# 2. Point the SPA at your function: edit API at the top of docs/app.js

# 3. Serve the SPA
python3 -m http.server 8321 --directory docs
```

## Environment variables / secrets

| Name | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | `supabase secrets set` on the function | Transaction-pooler Postgres URL (port 6543) |
| `SITE_ORIGIN` | function secret, optional | Public site base for share links (defaults to the GitHub Pages URL) |
| `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | local `.env` (gitignored) | CLI/migration convenience |

## Deploying

```bash
# API
supabase functions deploy draftday --project-ref <ref> --no-verify-jwt --use-api

# Frontend: push to main; GitHub Pages serves docs/ automatically
git push
```

## Adding a new competition type (e.g. an arcade game)

No schema migration needed:

1. Pick an enum value, e.g. `runner`, and add it to the `type` check constraint on
   `competitions` (one `alter table` — the only SQL touch, and it's additive).
2. Put its settings in `config` when creating the competition
   (e.g. `{max_attempts: 3, level_seed: …}`).
3. Server: branch on `comp.type` in `logic.ts`/`index.ts` — implement start/score/finalize
   writing generic `score` + `duration_ms` on `attempts` (use `state` jsonb for anything
   game-specific). Ranking, standings visibility, closing, DNF handling, and the reveal
   all work off `score`/`duration_ms` and are type-agnostic already.
4. Client: add a phase renderer in `docs/app.js` `memberView` for the new type's play
   screen. The join, lobby, done, and reveal screens are shared.
5. For best-of-N, read `config.max_attempts` where the code currently short-circuits to
   one attempt (`startAttempt`), and pick `max(score)` per participant in `standings()`.

## Question bank

30 original questions in `bank_version 1` — verbal analogies, word relationships, number
series, arithmetic word problems, logical deduction, proverb meaning, spatial/pattern,
calendar reasoning, and sentence disambiguation. Difficulty mix: 10 easy / 12 medium /
8 hard. Add a new bank by inserting rows with `bank_version = 2` and setting
`config.bank_version` on new competitions; old results are untouched.

## Monetization gates & A/B experiments

Nothing is paywalled today, but the infrastructure is live. Trigger points
("gates") are checked server-side and driven by the `app_config` row
`monetization` — flipping an experiment needs no deploy:

```sql
-- turn the placement experiment on
update app_config set value =
  jsonb_set(jsonb_set(jsonb_set(value,
    '{experiments,paywall_placement_v1,enabled}', 'true'),
    '{gates,activate_wonderlic,mode}', '"experiment"'),
    '{gates,missed_review,mode}', '"experiment"'),
  updated_at = now()
where key = 'monetization';
```

- **Gates:** `activate_wonderlic` (Begin Competition for the test) and
  `missed_review` (post-test answer key). Modes: `open` / `paid` / `experiment`.
- **Experiment `paywall_placement_v1`:** admins are hash-bucketed once
  (sticky, persisted in `admin_experiments`) into `gate_at_activation`
  (paywall before launch) or `upsell_later` (free launch, answer key gated).
- **Entitlements:** a row in `entitlements` (product `pro`) passes every gate —
  this is where a Stripe webhook will write when payments exist.
- **Funnel events** land in `events`: `gate_hit`, `experiment_assigned`,
  `competition_activated`, `member_joined`, `attempt_started`,
  `attempt_finished`, `participant_deleted`.
- Paywall copy lives in config (`paywall_copy`) and is rendered verbatim by the
  client, so messaging is testable without a frontend deploy.
- Warning from testing: enabling a gate affects **existing live leagues**
  immediately (an `upsell_later` admin's league loses the answer key mid-season).
  Scope future experiments to new signups if that matters.
