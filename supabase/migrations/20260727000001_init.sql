-- Draft Order Competition App — initial schema
create extension if not exists pgcrypto;

-- Admin accounts (league commissioners)
create table admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table admin_sessions (
  token text primary key,
  admin_id uuid not null references admins(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table leagues (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admins(id) on delete cascade,
  name text not null,
  season_year int not null,
  member_count int not null check (member_count between 2 and 64),
  created_at timestamptz not null default now()
);

-- One league can have many competitions across seasons.
-- Competition-type-specific settings live in `config` (jsonb), never in columns.
create table competitions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  type text not null check (type in ('wonderlic', 'random_order')),
  status text not null default 'draft' check (status in ('draft', 'active', 'closed')),
  config jsonb not null default '{}'::jsonb,
  share_token text unique,
  results_token text unique,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  closed_at timestamptz
);

create index competitions_league_idx on competitions(league_id);
create index competitions_share_token_idx on competitions(share_token);
create index competitions_results_token_idx on competitions(results_token);

-- Question bank. bank_version allows adding future banks without touching old data.
create table questions (
  id uuid primary key default gen_random_uuid(),
  bank_version int not null default 1,
  position int not null,
  category text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  prompt text not null,
  options jsonb not null,          -- array of exactly 4 strings
  correct_index int not null check (correct_index between 0 and 3),
  unique (bank_version, position)
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  display_name text not null,
  join_token text,                 -- reserved: future per-member single-use invite links
  session_token text,              -- identifies this participant's device via cookie
  shuffle_seed text,               -- per-participant shuffle seed (reproducible)
  is_dnf boolean not null default false,
  is_placeholder boolean not null default false,  -- unfilled slot marked DNF at close
  created_at timestamptz not null default now(),
  unique (competition_id, display_name)
);

create index participants_competition_idx on participants(competition_id);

-- Generic attempt/result record. No competition-type-specific columns:
-- score is numeric, duration is ms, per-type working data lives in `state` jsonb.
-- max_attempts is read from competitions.config (wonderlic: 1).
create table attempts (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  attempt_number int not null default 1,
  status text not null default 'in_progress' check (status in ('in_progress', 'finished')),
  started_at timestamptz,
  deadline_at timestamptz,
  finished_at timestamptz,
  score numeric,
  duration_ms int,
  state jsonb not null default '{}'::jsonb,
  unique (participant_id, attempt_number)
);

create index attempts_participant_idx on attempts(participant_id);
