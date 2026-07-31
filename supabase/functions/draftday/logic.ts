import sql, { randomToken } from "./db.ts";
import { logEvent } from "./gates.ts";

// ---------- deterministic shuffle (seed stored per participant) ----------

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(arr: T[], seed: string): T[] {
  const rand = mulberry32(xmur3(seed)());
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}


// jsonb round-trips as an object; tolerate legacy rows stored as a JSON string.
export function attemptState(attempt: any): any {
  const st = attempt?.state;
  return typeof st === "string" ? JSON.parse(st) : (st ?? {});
}

// ---------- lookups ----------

export async function competitionByShareToken(token: string) {
  const rows = await sql`select * from competitions where share_token = ${token}`;
  return rows[0] ?? null;
}

export async function competitionByResultsToken(token: string) {
  const rows = await sql`select * from competitions where results_token = ${token}`;
  return rows[0] ?? null;
}

export async function bankQuestions(bankVersion: number) {
  return await sql`
    select id, position, prompt, options, correct_index
    from questions where bank_version = ${bankVersion} order by position`;
}

export async function finishedCount(competitionId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from attempts a
    join participants p on p.id = a.participant_id
    where p.competition_id = ${competitionId} and a.status = 'finished'`;
  return row.n;
}

// Standings are visible once every league slot is accounted for, or the admin closed it.
export function standingsVisible(comp: any, finished: number): boolean {
  return comp.status === "closed" || finished >= comp.member_count;
}

export async function standings(comp: any) {
  const rows = await sql`
    select p.display_name, p.real_name, p.is_dnf, p.is_placeholder, a.score, a.duration_ms
    from participants p
    left join attempts a on a.participant_id = p.id and a.status = 'finished'
    where p.competition_id = ${comp.id} and (p.is_dnf or a.id is not null)
    order by p.is_dnf asc, a.score desc nulls last, a.duration_ms asc nulls last,
             a.finished_at asc nulls last, p.created_at asc`;
  return rows.map((r: any, i: number) => ({
    rank: i + 1,
    name: r.display_name,
    real_name: r.real_name,
    dnf: r.is_dnf,
    placeholder: r.is_placeholder,
    score: r.is_dnf ? null : r.score === null ? null : Number(r.score),
    duration_ms: r.is_dnf ? null : r.duration_ms,
  }));
}

// ---------- member flow ----------

export async function joinCompetition(comp: any, name: string, realName = "") {
  const trimmed = name.trim().slice(0, 40);
  const realTrimmed = realName.trim().slice(0, 60);
  if (!trimmed) return { error: "Enter a display name." };
  if (!realTrimmed) return { error: "Enter your actual name." };
  if (comp.status !== "active") return { error: "This competition is not open." };

  return await sql.begin(async (tx) => {
    await tx`select id from competitions where id = ${comp.id} for update`;
    const existing = await tx`
      select p.*, a.status as attempt_status from participants p
      left join attempts a on a.participant_id = p.id
      where p.competition_id = ${comp.id} and lower(p.display_name) = lower(${trimmed})`;
    if (existing.length) {
      const p = existing[0];
      // Same name re-entering: allow resume unless their attempt already finished.
      if (p.attempt_status === "finished" || p.is_dnf) {
        return { error: "That name has already completed. Pick a different name." };
      }
      return { participant: p };
    }
    const [{ n }] = await tx`
      select count(*)::int as n from participants
      where competition_id = ${comp.id} and not is_placeholder`;
    if (n >= comp.member_count) return { error: "This competition is full." };

    const [participant] = await tx`
      insert into participants (competition_id, display_name, real_name, session_token, shuffle_seed)
      values (${comp.id}, ${trimmed}, ${realTrimmed}, ${randomToken(18)}, ${randomToken(12)})
      returning *`;

    // Random-order mode: generating the order once, server-side, when the last slot fills.
    if (comp.type === "random_order" && n + 1 >= comp.member_count) {
      await generateRandomOrder(tx, comp.id);
    }
    return { participant };
  });
}

async function generateRandomOrder(tx: any, competitionId: string) {
  const [comp] = await tx`select * from competitions where id = ${competitionId} for update`;
  if (comp.config?.order_generated) return;
  const ps = await tx`
    select id from participants
    where competition_id = ${competitionId} and not is_dnf and not is_placeholder`;
  const order = [...ps];
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < order.length; i++) {
    await tx`
      insert into attempts (participant_id, status, started_at, finished_at, score, duration_ms)
      values (${order[i].id}, 'finished', now(), now(), ${order.length - i}, 0)
      on conflict (participant_id, attempt_number) do nothing`;
  }
  await tx`
    update competitions set config = config || '{"order_generated": true}'::jsonb
    where id = ${competitionId}`;
}

export async function participantBySession(competitionId: string, sessionToken: string | undefined) {
  if (!sessionToken) return null;
  const rows = await sql`
    select * from participants
    where competition_id = ${competitionId} and session_token = ${sessionToken}`;
  return rows[0] ?? null;
}

export async function currentAttempt(participantId: string) {
  const rows = await sql`
    select * from attempts where participant_id = ${participantId}
    order by attempt_number desc limit 1`;
  return rows[0] ?? null;
}

export async function startAttempt(comp: any, participant: any) {
  const existing = await currentAttempt(participant.id);
  if (existing) return existing; // one attempt: resume or show result, never restart
  const cfg = comp.config ?? {};
  let state: any;
  let limitSec: number;
  if (comp.type === "trex") {
    // One session: practice runs + the real run, against a session clock.
    state = { runs: [] };
    limitSec = cfg.session_limit_seconds ?? 900;
  } else {
    const bankVersion = cfg.bank_version ?? 1;
    limitSec = cfg.time_limit_seconds ?? 360;
    const questions = await bankQuestions(bankVersion);
    const order = seededShuffle(questions.map((q: any) => q.id), `q:${participant.shuffle_seed}`);
    const optionOrders: Record<string, number[]> = {};
    for (const q of questions) {
      optionOrders[q.id] = seededShuffle([0, 1, 2, 3], `o:${participant.shuffle_seed}:${q.id}`);
    }
    state = { question_order: order, option_orders: optionOrders, answers: {}, current_index: 0 };
  }
  const rows = await sql`
    insert into attempts (participant_id, started_at, deadline_at, state)
    values (${participant.id}, now(), now() + make_interval(secs => ${limitSec}), ${sql.json(state)})
    on conflict (participant_id, attempt_number) do nothing
    returning *`;
  if (rows[0]) {
    await logEvent("attempt_started", { competitionId: comp.id, participantId: participant.id });
  }
  return rows[0] ?? await currentAttempt(participant.id);
}

// The run that counts is the one after the practice runs.
export function realRunIndex(comp: any): number {
  return comp.config?.practice_runs ?? 3;
}

async function scoreAttempt(attempt: any, comp: any): Promise<number> {
  if (comp.type === "trex") {
    const runs = attemptState(attempt).runs ?? [];
    const real = runs[realRunIndex(comp)];
    return real ? Number(real.score) || 0 : 0;
  }
  const questions = await bankQuestions(comp.config?.bank_version ?? 1);
  const answers = attemptState(attempt).answers ?? {};
  let score = 0;
  for (const q of questions) {
    if (answers[q.id] === q.correct_index) score++;
  }
  return score;
}

// Finalize with server-computed duration. Timeout duration = full time limit.
export async function finalizeAttempt(attempt: any, comp: any, timedOut: boolean) {
  const score = await scoreAttempt(attempt, comp);
  const rows = await sql`
    update attempts set
      status = 'finished',
      finished_at = least(now(), deadline_at),
      score = ${score},
      duration_ms = (extract(epoch from (least(now(), deadline_at) - started_at)) * 1000)::int
    where id = ${attempt.id} and status = 'in_progress'
    returning *`;
  if (rows[0]) {
    await logEvent("attempt_finished", {
      participantId: attempt.participant_id,
      props: { score, duration_ms: rows[0].duration_ms, timed_out: timedOut },
    });
  }
  return rows[0] ?? await sql`select * from attempts where id = ${attempt.id}`.then((r) => r[0]);
}

export async function remainingMs(attempt: any): Promise<number> {
  const [row] = await sql`
    select greatest(0, (extract(epoch from (deadline_at - now())) * 1000)::int) as ms
    from attempts where id = ${attempt.id}`;
  return row?.ms ?? 0;
}

// Record an answer. displayedIndex is the position the member tapped;
// it maps back to the original option index via the stored per-participant shuffle.
export async function submitAnswer(
  comp: any,
  attempt: any,
  questionId: string,
  displayedIndex: number,
) {
  const ms = await remainingMs(attempt);
  if (ms <= 0) {
    const finalized = await finalizeAttempt(attempt, comp, true);
    return { done: true, attempt: finalized, timedOut: true };
  }
  const st = attemptState(attempt);
  const expected = st.question_order[st.current_index];
  if (questionId !== expected) {
    return { rejected: "out_of_sync" }; // client will re-fetch state
  }
  if (st.answers[questionId] !== undefined) return { rejected: "already_answered" };
  const mapping = st.option_orders[questionId];
  const original = Number.isInteger(displayedIndex) && displayedIndex >= 0 && displayedIndex <= 3
    ? mapping[displayedIndex]
    : null;
  st.answers[questionId] = original;
  st.current_index += 1;
  const [updated] = await sql`
    update attempts set state = ${sql.json(st)} where id = ${attempt.id} returning *`;
  if (st.current_index >= st.question_order.length) {
    const finalized = await finalizeAttempt(updated, comp, false);
    return { done: true, attempt: finalized };
  }
  return { done: false, attempt: updated };
}

// Record one T-Rex run (practice or real). Scores are clamped to what's
// physically possible in the elapsed session time (~13 points/sec in-game).
export async function submitRun(comp: any, attempt: any, rawScore: number) {
  const ms = await remainingMs(attempt);
  if (ms <= 0) {
    const finalized = await finalizeAttempt(attempt, comp, true);
    return { done: true, attempt: finalized, timedOut: true };
  }
  const st = attemptState(attempt);
  st.runs = st.runs ?? [];
  const totalRuns = realRunIndex(comp) + 1;
  if (st.runs.length >= totalRuns) return { done: true, attempt };
  const limitMs = (comp.config?.session_limit_seconds ?? 900) * 1000;
  const elapsedSec = Math.max(1, (limitMs - ms) / 1000);
  const cap = Math.floor(elapsedSec * 20 + 100);
  const score = Math.max(0, Math.min(Math.floor(Number(rawScore) || 0), cap));
  st.runs.push({ score });
  const [updated] = await sql`
    update attempts set state = ${sql.json(st)} where id = ${attempt.id} returning *`;
  if (st.runs.length >= totalRuns) {
    const finalized = await finalizeAttempt(updated, comp, false);
    return { done: true, attempt: finalized };
  }
  return { done: false, attempt: updated };
}

// ---------- admin close ----------

export async function closeCompetition(competitionId: string) {
  await sql.begin(async (tx) => {
    const [comp] = await tx`select * from competitions where id = ${competitionId} for update`;
    if (!comp || comp.status === "closed") return;

    if (comp.type === "wonderlic" || comp.type === "trex") {
      // Finalize anyone mid-attempt with what they have so far.
      const inProgress = await tx`
        select a.*, p.competition_id from attempts a
        join participants p on p.id = a.participant_id
        where p.competition_id = ${competitionId} and a.status = 'in_progress'`;
      const questions = comp.type === "wonderlic"
        ? await tx`
            select id, correct_index from questions
            where bank_version = ${comp.config?.bank_version ?? 1}`
        : [];
      for (const a of inProgress) {
        let score = 0;
        if (comp.type === "trex") {
          const real = (attemptState(a).runs ?? [])[realRunIndex(comp)];
          score = real ? Number(real.score) || 0 : 0;
        } else {
          for (const q of questions) if (attemptState(a).answers?.[q.id] === q.correct_index) score++;
        }
        await tx`
          update attempts set status = 'finished',
            finished_at = least(now(), deadline_at),
            score = ${score},
            duration_ms = (extract(epoch from (least(now(), deadline_at) - started_at)) * 1000)::int
          where id = ${a.id}`;
      }
      // Joined but never pressed Start -> DNF.
      await tx`
        update participants p set is_dnf = true
        where p.competition_id = ${competitionId}
          and not exists (select 1 from attempts a where a.participant_id = p.id)`;
    } else if (comp.type === "random_order") {
      await generateRandomOrder(tx, competitionId);
    }

    // Unfilled slots become placeholder DNFs so ranks 1..N are all assigned.
    const [{ n }] = await tx`
      select count(*)::int as n from participants
      where competition_id = ${competitionId}`;
    for (let i = n + 1; i <= comp.member_count; i++) {
      await tx`
        insert into participants (competition_id, display_name, is_dnf, is_placeholder)
        values (${competitionId}, ${"Did not start (" + (i - n) + ")"}, true, true)`;
    }

    await tx`
      update competitions set status = 'closed', closed_at = now()
      where id = ${competitionId}`;
  });
}
