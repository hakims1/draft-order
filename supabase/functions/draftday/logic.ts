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

// ---------- pricing (single source of truth; USD) ----------

export const PRICES = { ultimate: 19, answer_key: 5 };

// ---------- events ----------
// Single-event competitions have one event matching their type. The Combine
// runs a list of events; each event owns one attempt row per participant.

export function eventsFor(comp: any): string[] {
  if (comp.type === "combine") return comp.config?.events ?? ["wonderlic", "trex"];
  return [comp.type];
}

// Latest attempt per event for a participant.
export async function attemptsByEvent(participantId: string): Promise<Record<string, any>> {
  const rows = await sql`
    select distinct on (event_key) * from attempts
    where participant_id = ${participantId}
    order by event_key, attempt_number desc`;
  const map: Record<string, any> = {};
  for (const r of rows) map[r.event_key] = r;
  return map;
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
    select id, position, prompt, options, correct_index, explanation
    from questions where bank_version = ${bankVersion} order by position`;
}

// A participant is "finished" once every event of the competition is finished.
export async function finishedCount(comp: any): Promise<number> {
  const events = eventsFor(comp);
  const [row] = await sql`
    select count(*)::int as n from participants p
    where p.competition_id = ${comp.id} and not p.is_placeholder
      and (select count(distinct a.event_key) from attempts a
           where a.participant_id = p.id and a.status = 'finished'
             and a.event_key = any(${events})) >= ${events.length}`;
  return row.n;
}

// Standings are visible once every league slot is accounted for, or the admin closed it.
export function standingsVisible(comp: any, finished: number): boolean {
  return comp.status === "closed" || finished >= comp.member_count;
}

export async function standings(comp: any) {
  if (comp.type === "combine") return await combineStandings(comp);
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

// Combine ranking: rank each event separately with that event's normal sort,
// then average the positions. Raw scores are never mixed — the test is bounded
// 0–30 and the runner is unbounded, so score-averaging would let the runner
// swamp the test. A missed event scores last place in that event (finishers+1),
// so skipping a weak event can't help. Both event ranks and the average are
// returned so the group chat can audit the arithmetic.
async function combineStandings(comp: any) {
  const events = eventsFor(comp);
  const parts: any[] = await sql`
    select * from participants where competition_id = ${comp.id} order by created_at`;
  const atts: any[] = await sql`
    select a.* from attempts a
    join participants p on p.id = a.participant_id
    where p.competition_id = ${comp.id} and a.status = 'finished'`;
  const byPart = new Map<string, Record<string, any>>();
  for (const a of atts) {
    if (!byPart.has(a.participant_id)) byPart.set(a.participant_id, {});
    byPart.get(a.participant_id)![a.event_key] = a;
  }

  const pool = parts.filter((p) => !p.is_dnf);
  const ranks = new Map<string, Record<string, number>>();
  for (const p of pool) ranks.set(p.id, {});
  for (const ev of events) {
    const finishers = pool
      .filter((p) => byPart.get(p.id)?.[ev])
      .sort((a, b) => {
        const A = byPart.get(a.id)![ev], B = byPart.get(b.id)![ev];
        if (Number(B.score) !== Number(A.score)) return Number(B.score) - Number(A.score);
        if (A.duration_ms !== B.duration_ms) return A.duration_ms - B.duration_ms;
        return new Date(A.finished_at).getTime() - new Date(B.finished_at).getTime();
      });
    finishers.forEach((p, i) => { ranks.get(p.id)![ev] = i + 1; });
    const lastPlace = finishers.length + 1;
    for (const p of pool) {
      if (ranks.get(p.id)![ev] === undefined) ranks.get(p.id)![ev] = lastPlace;
    }
  }

  const scored = pool.map((p) => {
    const r = ranks.get(p.id)!;
    const avg = events.reduce((s, ev) => s + r[ev], 0) / events.length;
    const best = Math.min(...events.map((ev) => r[ev]));
    const durations = events.map((ev) => byPart.get(p.id)?.[ev]?.duration_ms);
    const totalDur = durations.reduce((s, d) => s + (d ?? 9e9), 0);
    const eventScores: Record<string, number | null> = {};
    for (const ev of events) {
      const a = byPart.get(p.id)?.[ev];
      eventScores[ev] = a ? Number(a.score) : null;
    }
    return { p, avg, best, totalDur, event_ranks: r, event_scores: eventScores };
  }).sort((a, b) =>
    a.avg - b.avg || a.best - b.best || a.totalDur - b.totalDur ||
    new Date(a.p.created_at).getTime() - new Date(b.p.created_at).getTime());

  const dnfs = parts.filter((p) => p.is_dnf);
  const rows: any[] = [];
  scored.forEach((s, i) => rows.push({
    rank: i + 1,
    name: s.p.display_name,
    real_name: s.p.real_name,
    dnf: false,
    placeholder: s.p.is_placeholder,
    score: Math.round(s.avg * 10) / 10,
    duration_ms: s.totalDur >= 9e9 ? null : s.totalDur,
    event_ranks: s.event_ranks,
    event_scores: s.event_scores,
  }));
  dnfs.forEach((p, i) => rows.push({
    rank: scored.length + i + 1,
    name: p.display_name,
    real_name: p.real_name,
    dnf: true,
    placeholder: p.is_placeholder,
    score: null,
    duration_ms: null,
  }));
  return rows;
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
      select p.* from participants p
      where p.competition_id = ${comp.id} and lower(p.display_name) = lower(${trimmed})`;
    if (existing.length) {
      const p = existing[0];
      // Same name re-entering: allow resume unless every event is already finished.
      const events = eventsFor(comp);
      const [{ fin }] = await tx`
        select count(distinct event_key)::int as fin from attempts
        where participant_id = ${p.id} and status = 'finished'
          and event_key = any(${events})`;
      if (fin >= events.length || p.is_dnf) {
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
      insert into attempts (participant_id, event_key, status, started_at, finished_at, score, duration_ms)
      values (${order[i].id}, 'random_order', 'finished', now(), now(), ${order.length - i}, 0)
      on conflict (participant_id, event_key, attempt_number) do nothing`;
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

export async function currentAttempt(participantId: string, eventKey: string) {
  const rows = await sql`
    select * from attempts
    where participant_id = ${participantId} and event_key = ${eventKey}
    order by attempt_number desc limit 1`;
  return rows[0] ?? null;
}

export async function startAttempt(comp: any, participant: any, eventKey: string) {
  const existing = await currentAttempt(participant.id, eventKey);
  if (existing) return existing; // one attempt per event: resume, never restart
  const cfg = comp.config ?? {};
  let state: any;
  let limitSec: number;
  if (eventKey === "trex") {
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
    insert into attempts (participant_id, event_key, started_at, deadline_at, state)
    values (${participant.id}, ${eventKey}, now(), now() + make_interval(secs => ${limitSec}), ${sql.json(state)})
    on conflict (participant_id, event_key, attempt_number) do nothing
    returning *`;
  if (rows[0]) {
    await logEvent("attempt_started", { competitionId: comp.id, participantId: participant.id, props: { event: eventKey } });
  }
  return rows[0] ?? await currentAttempt(participant.id, eventKey);
}

// The run that counts is the one after the practice runs.
export function realRunIndex(comp: any): number {
  return comp.config?.practice_runs ?? 3;
}

async function scoreAttempt(attempt: any, comp: any): Promise<number> {
  const key = attempt.event_key ?? comp.type;
  if (key === "trex") {
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

// ---------- answer key (paid, per-seat) ----------

export async function participantKeyEntitled(participantId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from entitlements
    where granted_to_participant_id = ${participantId} and sku = 'answer_key'`;
  return rows.length > 0;
}

// The full key for one buyer: their own sheet question by question, plus what
// every other FINISHED member missed. Members who haven't finished the test
// are simply absent — they have no answers yet.
export async function buildAnswerKey(comp: any, buyer: any) {
  const bank = await bankQuestions(comp.config?.bank_version ?? 1);
  const own = await currentAttempt(buyer.id, "wonderlic");
  const ownAnswers = own ? (attemptState(own).answers ?? {}) : {};
  const yours = bank.map((q: any) => {
    const pick = ownAnswers[q.id];
    return {
      prompt: q.prompt,
      correct: q.options[q.correct_index],
      your_answer: pick === null || pick === undefined ? null : q.options[pick],
      got_it: pick === q.correct_index,
      explanation: q.explanation,
    };
  });
  const others = await sql`
    select p.id, p.display_name, p.real_name, a.score, a.state from attempts a
    join participants p on p.id = a.participant_id
    where p.competition_id = ${comp.id} and a.event_key = 'wonderlic'
      and a.status = 'finished' and p.id != ${buyer.id}
    order by a.score desc, a.duration_ms asc`;
  const members = others.map((m: any) => {
    const answers = attemptState(m).answers ?? {};
    const missed = bank
      .filter((q: any) => answers[q.id] !== q.correct_index)
      .map((q: any) => ({
        prompt: q.prompt,
        their_answer: answers[q.id] === null || answers[q.id] === undefined ? null : q.options[answers[q.id]],
        correct: q.options[q.correct_index],
      }));
    return { name: m.display_name, real_name: m.real_name, score: Number(m.score), missed };
  });
  return { yours, members };
}

// ---------- admin close ----------

export async function closeCompetition(competitionId: string) {
  await sql.begin(async (tx) => {
    const [comp] = await tx`select * from competitions where id = ${competitionId} for update`;
    if (!comp || comp.status === "closed") return;

    if (comp.type !== "random_order") {
      // Finalize anyone mid-attempt with what they have so far (per event).
      const inProgress = await tx`
        select a.*, p.competition_id from attempts a
        join participants p on p.id = a.participant_id
        where p.competition_id = ${competitionId} and a.status = 'in_progress'`;
      const questions = await tx`
        select id, correct_index from questions
        where bank_version = ${comp.config?.bank_version ?? 1}`;
      for (const a of inProgress) {
        let score = 0;
        if (a.event_key === "trex") {
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
