import { Hono } from "npm:hono@4.6.14";
import sql, { randomToken } from "./db.ts";
import { adminFromSession, createSession, destroySession, hashPassword, verifyPassword } from "./auth.ts";
import {
  PRICES,
  attemptsByEvent,
  bankQuestions,
  compQuestions,
  buildAnswerKey,
  eventsFor,
  participantKeyEntitled,
  closeCompetition,
  competitionByResultsToken,
  competitionByShareToken,
  attemptState,
  currentAttempt,
  finalizeAttempt,
  finishedCount,
  joinCompetition,
  participantBySession,
  remainingMs,
  standings,
  standingsVisible,
  realRunIndex,
  startAttempt,
  submitAnswer,
  submitAnswers,
  submitRun,
} from "./logic.ts";
import { checkGate, hasEntitlement, isOwner, logEvent } from "./gates.ts";
import { buildCompletionEmail, emailEnabled, notifyCompetitionComplete } from "./email.ts";
import {
  confirmSession,
  createCheckoutSession,
  grantEntitlement,
  handleWebhook,
  stripeEnabled,
} from "./stripe.ts";

const FN = "draftday";
// Bumped with every frontend release; stale clients hard-reload themselves.
const APP_VERSION = 37;
// Public site (GitHub Pages). Share/results URLs are built against this.
const SITE = (Deno.env.get("SITE_ORIGIN") ?? "https://hakims1.github.io/draft-order/").replace(/\/?$/, "/");

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-pt",
      "access-control-max-age": "86400",
    });
  }
  await next();
  c.res.headers.set("access-control-allow-origin", "*");
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong. Try again." }, 500);
});

app.get("/health", async (c) => {
  await sql`select 1`;
  return c.text("ok");
});
app.get("/", (c) => c.redirect(SITE));
// Raw function URLs redirect to the real site so old links still work.
app.get("/c/:token", (c) => c.redirect(`${SITE}#/c/${c.req.param("token")}`));
app.get("/r/:rtoken", (c) => c.redirect(`${SITE}#/r/${c.req.param("rtoken")}`));

// ---------------- member flow ----------------

// Finalize any expired in-progress attempts in this competition so counts and
// standings visibility never get stuck on an abandoned tab.
async function sweepExpired(comp: any) {
  const expired = await sql`
    select a.* from attempts a
    join participants p on p.id = a.participant_id
    where p.competition_id = ${comp.id} and a.status = 'in_progress' and a.deadline_at < now()`;
  for (const a of expired) await finalizeAttempt(a, comp, true);
}

// "The order is in" email to the commissioner, fired the first time anyone
// observes the competition as complete — the last member's submit, another
// member's poll, or a manual close. notifyCompetitionComplete() claims the
// send with a conditional UPDATE, so concurrent observers can't double-send.
// Detached from the response: nobody waits on an email hop.
function notifyIfComplete(comp: any, visible: boolean) {
  if (!visible || comp?.completed_notified_at) return;
  const p = notifyCompetitionComplete(comp, SITE).catch((e) =>
    console.error("completion notify failed:", e));
  try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* not on Edge Runtime */ }
}

async function memberState(c: any, comp: any, light = false) {
  await sweepExpired(comp);
  const ptoken = c.req.header("x-pt") || undefined;
  const participant = await participantBySession(comp.id, ptoken);
  const finished = await finishedCount(comp);
  const [{ joined }] = await sql`
    select count(*)::int as joined from participants
    where competition_id = ${comp.id} and not is_placeholder`;
  const visible = standingsVisible(comp, finished);
  notifyIfComplete(comp, visible);
  const league = { name: comp.name, member_count: comp.member_count };
  const displayCount = comp.type === "random_order" ? joined : finished;
  const events = eventsFor(comp);
  const payload: any = { type: comp.type, league, finished: displayCount, competition_id: comp.id, app_version: APP_VERSION };
  if (comp.type === "combine") payload.events = events;

  const atts: Record<string, any> = participant ? await attemptsByEvent(participant.id) : {};
  const allFinished = !!participant && events.every((e) => atts[e]?.status === "finished");

  if (allFinished && comp.type !== "random_order") {
    if (comp.type === "combine") {
      payload.result = {
        events: events.map((e) => ({ key: e, score: Number(atts[e].score), duration_ms: atts[e].duration_ms })),
        duration_ms: events.reduce((sum, e) => sum + (atts[e].duration_ms ?? 0), 0),
        total: null,
      };
    } else {
      const a = atts[comp.type];
      payload.result = {
        score: Number(a.score),
        total: comp.type === "wonderlic" ? (comp.config?.question_count ?? 30) : null,
        duration_ms: a.duration_ms,
      };
    }
  }

  // The answer key (paid, per-seat). Only competitions with a test event have
  // one, and only a participant whose own test attempt is finished may see or
  // buy it — that single rule keeps answers away from anyone still playing.
  if (!light && participant && events.includes("wonderlic")) {
    const testAtt = atts["wonderlic"];
    if (testAtt?.status === "finished") {
      let entitled = await participantKeyEntitled(participant.id);
      if (!entitled) {
        // Organizer's included access: Ultimate covers their own competitions,
        // but their seat still has to be finished (checked above).
        const admin = await requireAdmin(c);
        if (admin && admin.id === comp.admin_id && (await hasEntitlement(admin.id, "ultimate"))) {
          entitled = true;
        }
      }
      if (entitled) {
        payload.answer_key = await buildAnswerKey(comp, participant);
      } else {
        payload.key_locked = true;
        payload.key_price = PRICES.answer_key;
      }
    } else {
      payload.key_teaser = true; // hasn't finished: locked, with an explanation
    }
  }

  if (visible) {
    payload.phase = "standings";
    payload.standings = await standings(comp);
    payload.results_url = comp.results_token ? `${SITE}#/r/${comp.results_token}` : null;
    return payload;
  }
  // Landing-page leaderboard: everyone who has finished so far, best first.
  async function currentLeaderboard() {
    if (comp.type === "random_order") {
      const roster = await sql`
        select display_name from participants
        where competition_id = ${comp.id} and not is_placeholder
        order by created_at`;
      return { roster: roster.map((r: any) => r.display_name) };
    }
    if (comp.type === "combine") {
      const rows = await sql`
        select p.display_name, p.real_name,
          (select count(distinct a.event_key)::int from attempts a
            where a.participant_id = p.id and a.status = 'finished'
              and a.event_key = any(${events})) as done
        from participants p
        where p.competition_id = ${comp.id} and not p.is_placeholder
        order by done desc, p.created_at`;
      return {
        roster_combine: rows.map((r: any) => ({
          name: r.display_name, real_name: r.real_name, done: r.done, total: events.length,
        })),
      };
    }
    const rows = await sql`
      select p.display_name, p.real_name, a.score, a.duration_ms from attempts a
      join participants p on p.id = a.participant_id
      where p.competition_id = ${comp.id} and a.status = 'finished'
      order by a.score desc, a.duration_ms asc, a.finished_at asc`;
    return {
      leaderboard: rows.map((r: any, i: number) => ({
        rank: i + 1, name: r.display_name, real_name: r.real_name,
        score: Number(r.score), duration_ms: r.duration_ms,
      })),
    };
  }

  if (!participant) {
    payload.phase = comp.status === "active" ? "join" : "error";
    if (payload.phase === "error") payload.error = "This competition is not open.";
    else Object.assign(payload, await currentLeaderboard());
    return payload;
  }
  payload.participant = { name: participant.display_name };
  if (comp.type === "random_order") {
    payload.phase = "lobby";
    return payload;
  }

  const currentEvent = events.find((e) => atts[e]?.status !== "finished");
  if (!currentEvent) {
    payload.phase = "done";
    if (comp.type !== "combine") {
      const a = atts[comp.type];
      payload.timed_out = a.duration_ms != null && a.duration_ms >= (comp.config?.time_limit_seconds ?? 360) * 1000;
    }
    if (!light) Object.assign(payload, await currentLeaderboard());
    return payload;
  }

  payload.event = { key: currentEvent, index: events.indexOf(currentEvent), total: events.length };
  if (comp.type === "combine") {
    payload.completed_events = events
      .filter((e) => atts[e]?.status === "finished")
      .map((e) => ({ key: e, score: Number(atts[e].score) }));
  }

  const attempt = atts[currentEvent];
  if (!attempt) {
    payload.phase = "ready";
    if (payload.event.index === 0) Object.assign(payload, await currentLeaderboard());
    return payload;
  }
  const ms = await remainingMs(attempt);
  if (ms <= 0) {
    await finalizeAttempt(attempt, comp, true);
    return await memberState(c, comp, light);
  }
  const st = attemptState(attempt);
  if (currentEvent === "trex") {
    payload.phase = "game";
    payload.remaining_ms = ms;
    payload.run_index = (st.runs ?? []).length;
    payload.practice_runs = realRunIndex(comp);
    payload.runs = (st.runs ?? []).map((r: any) => r.score);
    return payload;
  }
  payload.phase = "question";
  payload.remaining_ms = ms;
  payload.current_index = st.current_index;
  payload.total = st.question_order.length;
  // Answer acks are light: the client already holds the full question set and
  // only needs the re-synced clock. Start/state responses carry everything so
  // the client never waits on the network between questions.
  if (!light) {
    const questions = await compQuestions(comp);
    const qmap = new Map(questions.map((q: any) => [q.id, q]));
    payload.questions = st.question_order.map((qid: string) => {
      const q: any = qmap.get(qid);
      return {
        id: qid,
        prompt: q.prompt,
        options: st.option_orders[qid].map((oi: number) => q.options[oi]),
      };
    });
  }
  return payload;
}

app.get("/c/:token/state.json", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  return c.json(await memberState(c, comp));
});

app.post("/c/:token/join", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ error: "Competition not found." }, 404);
  const { name, real_name } = await c.req.json().catch(() => ({}));
  const res: any = await joinCompetition(comp, String(name ?? ""), String(real_name ?? ""));
  if (res.error) return c.json({ error: res.error });
  await logEvent("member_joined", { competitionId: comp.id, participantId: res.participant.id, props: { type: comp.type } });
  return c.json({ ok: true, participant_token: res.participant.session_token });
});

// Start (or resume) the participant's current event.
app.post("/c/:token/start", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  if (!participant) return c.json({ phase: "error", error: "Join first." });
  if (comp.type !== "random_order" && comp.status === "active") {
    const events = eventsFor(comp);
    const atts = await attemptsByEvent(participant.id);
    const currentEvent = events.find((e) => atts[e]?.status !== "finished");
    if (currentEvent) await startAttempt(comp, participant, currentEvent);
  }
  return c.json(await memberState(c, comp));
});

// The 2D Yard Dash: record one run (practice or real). The final run finalizes the event.
app.post("/c/:token/run", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  const attempt = participant ? await currentAttempt(participant.id, "trex") : null;
  if (attempt && attempt.status === "in_progress") {
    const body = await c.req.json().catch(() => ({}));
    await submitRun(comp, attempt, Number(body.score));
  }
  return c.json(await memberState(c, comp));
});

// Batched answers: the fast path. Mid-test acks skip the full state rebuild;
// only the finalizing batch pays for a complete member state.
app.post("/c/:token/answers", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  const attempt = participant ? await currentAttempt(participant.id, "wonderlic") : null;
  if (!attempt || attempt.status !== "in_progress") {
    return c.json(await memberState(c, comp));
  }
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.answers) ? body.answers.slice(0, 40) : [];
  const res = await submitAnswers(comp, attempt, items);
  if (res.done) return c.json(await memberState(c, comp));
  return c.json({ phase: "question", remaining_ms: res.remaining_ms, current_index: res.current_index });
});

app.post("/c/:token/answer", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  const attempt = participant ? await currentAttempt(participant.id, "wonderlic") : null;
  if (attempt && attempt.status === "in_progress") {
    const body = await c.req.json().catch(() => ({}));
    await submitAnswer(comp, attempt, String(body.question_id ?? ""), Number(body.displayed_index));
  }
  return c.json(await memberState(c, comp, true));
});

// ---------------- public results data ----------------

app.get("/r/:rtoken/data.json", async (c) => {
  const comp = await competitionByResultsToken(c.req.param("rtoken"));
  if (!comp) return c.json({ error: "not found" }, 404);
  await sweepExpired(comp);
  const finished = await finishedCount(comp);
  const visible = standingsVisible(comp, finished);
  return c.json({
    visible,
    finished,
    member_count: comp.member_count,
    league_name: comp.name,
    type: comp.type,
    // Before the reveal this is the live partial ranking (finishers only);
    // once visible it is the final order including DNFs.
    standings: await standings(comp),
  });
});

// Public click-tracking for whitelisted funnel events (e.g. the viral CTA on
// the completion screen). share_token attributes the click to a competition.
const TRACKABLE = new Set(["cta_start_own_clicked"]);
app.post("/track", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  // Campaign visits: the SPA pings {src} once per session when a URL carries
  // ?src=... (e.g. theprovingground.app/?src=ig-bio). Top-of-funnel clicks.
  const src = String(b.src ?? "").trim().slice(0, 64);
  if (src && b.name === undefined) {
    await logEvent("visit", { props: { src } });
    return c.json({ ok: true });
  }
  const name = String(b.name ?? "");
  if (!TRACKABLE.has(name)) return c.json({ ok: false });
  let competitionId: string | undefined;
  if (b.share_token) {
    const comp = await competitionByShareToken(String(b.share_token));
    competitionId = comp?.id;
  }
  await logEvent(name, { competitionId });
  return c.json({ ok: true });
});

// ---------------- admin auth ----------------

async function requireAdmin(c: any) {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return await adminFromSession(token);
}

app.post("/admin/signup", async (c) => {
  const { email: rawEmail, password, ref, src: rawSrc } = await c.req.json().catch(() => ({}));
  const src = String(rawSrc ?? "").trim().slice(0, 64);
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!email.includes("@") || String(password ?? "").length < 8) {
    return c.json({ error: "Enter a valid email and a password of 8+ characters." });
  }
  const existing = await sql`select id from admins where email = ${email}`;
  if (existing.length) return c.json({ error: "That email already has an account. Log in instead." });
  const [admin] = await sql`
    insert into admins (email, password_hash) values (${email}, ${await hashPassword(String(password))})
    returning id`;
  // Attribute the signup to the competition whose CTA sent them here, if any.
  let refCompId: string | undefined;
  if (typeof ref === "string" && ref) {
    const refComp = await competitionByShareToken(ref);
    refCompId = refComp?.id;
  }
  await logEvent("signup", {
    adminId: admin.id,
    competitionId: refCompId,
    props: src ? { via_cta: !!refCompId, src } : { via_cta: !!refCompId },
  });
  return c.json({ token: await createSession(admin.id) });
});

app.post("/admin/login", async (c) => {
  const { email: rawEmail, password } = await c.req.json().catch(() => ({}));
  const email = String(rawEmail ?? "").trim().toLowerCase();
  const [admin] = await sql`select * from admins where email = ${email}`;
  if (!admin || !(await verifyPassword(String(password ?? ""), admin.password_hash))) {
    return c.json({ error: "Wrong email or password." });
  }
  return c.json({ token: await createSession(admin.id) });
});

app.post("/admin/logout", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) await destroySession(auth.slice(7));
  return c.json({ ok: true });
});

// ---------------- admin api ----------------

app.get("/api/admin/dashboard", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const competitions = await sql`
    select id, name, member_count, type, status, created_at
    from competitions where admin_id = ${admin.id} order by created_at desc`;
  return c.json({
    email: admin.email,
    competitions,
    is_owner: await isOwner(admin.email),
    entitlements: { ultimate: await hasEntitlement(admin.id, "ultimate") },
    prices: PRICES,
  });
});

// Owner-only business metrics: overview counts plus per-account detail.
app.get("/api/admin/metrics", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  if (!(await isOwner(admin.email))) return c.json({ error: "forbidden" }, 403);

  const [totals] = await sql`
    with comp_state as (
      select c.id, c.status, c.type, c.member_count,
        (select count(*) from attempts a join participants p on p.id = a.participant_id
          where p.competition_id = c.id and a.status = 'finished') as fin
      from competitions c
    )
    select
      (select count(*)::int from admins) as accounts,
      (select count(*)::int from comp_state) as competitions,
      (select count(*)::int from comp_state where status = 'draft') as drafts,
      (select count(*)::int from comp_state where status = 'closed' or (status = 'active' and fin >= member_count)) as completed,
      (select count(*)::int from comp_state where status = 'active' and fin < member_count) as pending,
      (select count(*)::int from participants where not is_placeholder) as members_joined,
      (select count(*)::int from attempts where status = 'finished' and duration_ms > 0) as tests_finished,
      (select coalesce(round(avg(score), 1), 0)::float from attempts where status = 'finished' and duration_ms > 0) as avg_score,
      (select count(*)::int from events where name = 'cta_start_own_clicked') as cta_clicks,
      (select count(*)::int from events where name = 'signup' and (props->>'via_cta')::boolean) as signups_via_cta,
      (select count(*)::int from events where name = 'signup' and created_at > now() - interval '7 days') as signups_7d,
      (select count(*)::int from events where name = 'attempt_finished' and created_at > now() - interval '7 days') as tests_finished_7d`;

  const accounts = await sql`
    select a.email, a.created_at,
      count(distinct c.id)::int as competitions,
      count(distinct p.id) filter (where not p.is_placeholder)::int as members_joined,
      count(distinct at.id) filter (where at.status = 'finished')::int as finished
    from admins a
    left join competitions c on c.admin_id = a.id
    left join participants p on p.competition_id = c.id
    left join attempts at on at.participant_id = p.id
    group by a.id, a.email, a.created_at
    order by a.created_at desc`;

  // Campaign funnel: for every ?src= tag, clicks (visit pings) → signups
  // attributed to that source → what those accounts went on to do.
  const sources = await sql`
    with visits as (
      select props->>'src' as src, count(*)::int as clicks
      from events where name = 'visit' and props->>'src' is not null
      group by 1),
    cohort as (
      select props->>'src' as src, admin_id
      from events where name = 'signup' and props->>'src' is not null and admin_id is not null),
    per_admin as (
      select co.src, co.admin_id,
        (select count(*)::int from competitions c where c.admin_id = co.admin_id) as comps,
        (select count(*)::int from competitions c where c.admin_id = co.admin_id and c.status <> 'draft') as activated,
        (select count(*)::int from events e where e.name = 'purchase_mock' and e.admin_id = co.admin_id) as purchases
      from cohort co)
    select coalesce(v.src, p.src) as src,
      coalesce(max(v.clicks), 0)::int as clicks,
      count(p.admin_id)::int as signups,
      coalesce(sum(p.comps), 0)::int as competitions,
      coalesce(sum(p.activated), 0)::int as activated,
      coalesce(sum(p.purchases), 0)::int as purchases
    from visits v full outer join per_admin p on p.src = v.src
    group by coalesce(v.src, p.src)
    order by 2 desc`;

  return c.json({ totals, accounts, sources });
});

// One-step creation: game type + name + member count -> a draft competition.
app.post("/api/admin/competitions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().slice(0, 60);
  const members = parseInt(b.member_count, 10);
  const type = ["random_order", "trex", "combine"].includes(String(b.type)) ? String(b.type) : "wonderlic";
  if (!name) return c.json({ error: "Give your league a name." });
  if (!(members >= 2 && members <= 64)) return c.json({ error: "Members must be between 2 and 64." });
  // Premium gates — enforced here, not just in the UI.
  const ultimate = await hasEntitlement(admin.id, "ultimate");
  if (members > 12 && !ultimate) {
    return c.json({ error: "The free tier caps at 12 players.", upsell: "ultimate" });
  }
  if (type === "combine" && !ultimate) {
    return c.json({ error: "The Skill and Wit Combine needs Ultimate.", upsell: "ultimate" });
  }
  const config: any = type === "wonderlic"
    ? { bank_version: 3, question_count: 30, time_limit_seconds: 360, max_attempts: 1 }
    : type === "trex"
    ? { practice_runs: 3, session_limit_seconds: 900, max_attempts: 1 }
    : type === "combine"
    ? { events: ["wonderlic", "trex"], bank_version: 3, question_count: 30,
        time_limit_seconds: 360, practice_runs: 3, session_limit_seconds: 900, max_attempts: 1 }
    : { max_attempts: 1 };
  // Draw this competition's 30 questions from the big bank — stratified so
  // every test gets a mix of verbal, numeric, and reasoning items.
  // Percentage math is capped at 2 per test: it's slow to do mentally and the
  // easiest category to cheat with a calculator. (Existing competitions are
  // unaffected — their 30 questions are pinned by id at creation.)
  if (type === "wonderlic" || type === "combine") {
    const pick = async (cats: string[], n: number) =>
      (await sql`
        select id from questions where bank_version = 3 and category = any(${cats})
        order by random() limit ${n}`).map((r: any) => r.id);
    const percentQs = (await sql`
      select id from questions where bank_version = 3 and category = 'arithmetic'
        and position('%' in prompt) > 0
      order by random() limit 2`).map((r: any) => r.id);
    const otherNumeric = (await sql`
      select id from questions where bank_version = 3
        and (category = 'number_series'
             or (category = 'arithmetic' and position('%' in prompt) = 0))
      order by random() limit ${10 - percentQs.length}`).map((r: any) => r.id);
    config.question_ids = [
      ...(await pick(["analogy", "word_relation"], 10)),
      ...percentQs,
      ...otherNumeric,
      ...(await pick(["logic", "calendar", "pattern"], 10)),
    ];
  }
  const [comp] = await sql`
    insert into competitions (admin_id, name, member_count, type, config)
    values (${admin.id}, ${name}, ${members}, ${type}, ${sql.json(config)})
    returning id`;
  return c.json({ id: comp.id });
});

// Edit name/size after creation (from the competition page).
app.post("/api/admin/competition/:id/settings", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().slice(0, 60) || comp.name;
  const members = parseInt(b.member_count, 10);
  let memberCount = members >= 2 && members <= 64 ? members : comp.member_count;
  if (memberCount > 12 && !(await hasEntitlement(admin.id, "ultimate"))) {
    return c.json({ error: "The free tier caps at 12 players.", upsell: "ultimate" });
  }
  await sql`
    update competitions set name = ${name}, member_count = ${memberCount}
    where id = ${comp.id}`;
  return c.json({ ok: true });
});

async function ownedCompetition(adminId: string, compId: string) {
  const rows = await sql`
    select * from competitions
    where id = ${compId} and admin_id = ${adminId}`.catch(() => []);
  if (!rows[0]) return null;
  if (typeof rows[0].config === "string") { try { rows[0].config = JSON.parse(rows[0].config); } catch {} }
  return rows[0];
}

app.get("/api/admin/competition/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  return c.json({
    competition: {
      id: comp.id, name: comp.name, member_count: comp.member_count,
      type: comp.type, status: comp.status, config: comp.config,
      share_token: comp.share_token, results_token: comp.results_token,
      activated_at: comp.activated_at, closed_at: comp.closed_at,
    },
  });
});

app.post("/api/admin/competition/:id/activate", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (comp.status === "draft") {
    // Paywall trigger point A: launching a Wonderlic competition.
    // Currently open for everyone; flip via app_config, no redeploy needed.
    if (comp.type === "wonderlic") {
      const gate = await checkGate("activate_wonderlic", admin.id, { competitionId: comp.id });
      if (!gate.open) return c.json({ paywall: gate.paywall });
    }
    await sql`
      update competitions set status = 'active', activated_at = now(),
        share_token = ${randomToken(18)}, results_token = ${randomToken(18)}
      where id = ${comp.id}`;
    await logEvent("competition_activated", { adminId: admin.id, competitionId: comp.id, props: { type: comp.type } });
  }
  return c.json({ ok: true });
});

// Renders the completion email for one of your own competitions without
// sending it. Returned as JSON because Supabase rewrites text/html on
// *.supabase.co responses.
app.get("/api/admin/competition/:id/email-preview", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  const [owned] = await sql`
    select 1 from entitlements
    where revoked_at is null
      and ((sku = 'ultimate' and admin_id = ${admin.id})
        or (sku = 'answer_key' and competition_id = ${comp.id} and buyer_admin_id = ${admin.id}))`;
  const mail = await buildCompletionEmail(comp, SITE, { canBuyKey: !owned, hasKey: !!owned });
  return c.json({ to: admin.email, ...mail, would_send: emailEnabled() });
});

app.post("/api/admin/competition/:id/close", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (comp.status === "active") await closeCompetition(comp.id);
  notifyIfComplete(comp, true); // closing is a completion too
  return c.json({ ok: true });
});

// Remove a duplicate/mistaken entry. Allowed until the competition is closed.
// In random mode any existing draw is voided so it re-runs when the league
// fills again — otherwise a deleted slot could never be refilled.
app.post("/api/admin/competition/:id/participants/:pid/delete", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (comp.status === "closed") return c.json({ error: "Competition is closed — the order is final." });
  const deleted = await sql`
    delete from participants
    where id = ${c.req.param("pid")} and competition_id = ${comp.id}
    returning display_name`.catch(() => []);
  if (!deleted.length) return c.json({ error: "Entry not found." });
  if (comp.type === "random_order") {
    await sql.begin(async (tx) => {
      await tx`
        delete from attempts a using participants p
        where a.participant_id = p.id and p.competition_id = ${comp.id}`;
      await tx`
        update competitions set config = config - 'order_generated'
        where id = ${comp.id}`;
    });
  }
  await logEvent("participant_deleted", {
    adminId: admin.id, competitionId: comp.id, props: { name: deleted[0].display_name },
  });
  return c.json({ ok: true });
});

app.get("/api/admin/competition/:id/live", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  await sweepExpired(comp);
  const events = eventsFor(comp);
  const rows = await sql`
    select p.id, p.display_name, p.real_name, p.is_dnf, p.created_at,
      count(a.id) filter (where a.started_at is not null)::int as started_events,
      count(a.id) filter (where a.status = 'finished')::int as done_events,
      max(a.score) filter (where a.event_key = 'wonderlic' and a.status = 'finished') as test_score,
      max(a.score) filter (where a.event_key = 'trex' and a.status = 'finished') as dash_score,
      max(a.score) filter (where a.status = 'finished') as any_score,
      sum(a.duration_ms) filter (where a.status = 'finished')::int as total_dur
    from participants p
    left join attempts a on a.participant_id = p.id
    where p.competition_id = ${comp.id}
    group by p.id
    order by p.created_at`;
  const finished = await finishedCount(comp);
  return c.json({
    finished,
    member_count: comp.member_count,
    status: comp.status,
    events: events.length,
    participants: rows.map((r: any) => {
      const done = r.done_events >= events.length && !r.is_dnf;
      let score: any = null;
      if (done) {
        score = comp.type === "combine"
          ? `T:${r.test_score ?? "—"} D:${r.dash_score ?? "—"}`
          : Number(r.any_score);
      } else if (comp.type === "combine" && r.done_events > 0 && !r.is_dnf) {
        score = `${r.done_events}/${events.length} events`;
      }
      return {
        id: r.id,
        name: r.display_name,
        real_name: r.real_name,
        dnf: r.is_dnf,
        started: r.started_events > 0,
        finished: done,
        score,
        duration_ms: done ? r.total_dur : null,
      };
    }),
  });
});

// ---------------- entitlements (mock purchases; real payments swap in later) ----------------

// ---------------- payments ----------------

// One endpoint for both SKUs. With Stripe configured it returns a Checkout
// URL; without it, it performs the mock grant that carried the product before
// payments existed, so the flow works identically in both worlds and the
// client only has to ask "did I get a url back?".
app.post("/api/checkout", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const sku = String(b.sku ?? "");
  if (sku !== "ultimate" && sku !== "answer_key") return c.json({ error: "Unknown sku." }, 400);

  if (sku === "ultimate") {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: "unauthorized" }, 401);
    if (await hasEntitlement(admin.id, "ultimate")) return c.json({ ok: true, already: true });

    if (!stripeEnabled()) {
      await grantEntitlement({ sku, adminId: admin.id, source: "mock" });
      await logEvent("purchase_mock", { adminId: admin.id, props: { sku, price: PRICES.ultimate } });
      return c.json({ ok: true, mock: true });
    }
    const url = await createCheckoutSession({
      sku, site: SITE, returnHash: "/admin", adminId: admin.id, email: admin.email,
    });
    await logEvent("checkout_started", { adminId: admin.id, props: { sku, price: PRICES.ultimate } });
    return c.json({ url });
  }

  // answer_key — per seat, and only for a seat that has finished its test.
  const compId = String(b.competition_id ?? "");
  const rows = await sql`select * from competitions where id = ${compId}`.catch(() => []);
  const comp = rows[0];
  if (!comp) return c.json({ error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  if (!participant) return c.json({ error: "unauthorized" }, 401);
  const testAtt = await currentAttempt(participant.id, "wonderlic");
  if (testAtt?.status !== "finished") {
    return c.json({ error: "Finish your test first — then the key unlocks." }, 403);
  }
  if (await participantKeyEntitled(participant.id)) return c.json({ ok: true, already: true });

  // The buyer signs up before checkout, so an admin account is normally
  // present; it is recorded as the payer for receipts and refunds.
  const buyer = await requireAdmin(c);
  if (!stripeEnabled()) {
    await grantEntitlement({
      sku, competitionId: comp.id, participantId: participant.id,
      adminId: buyer?.id ?? null, source: "mock",
    });
    await logEvent("purchase_mock", {
      competitionId: comp.id, participantId: participant.id,
      props: { sku, price: PRICES.answer_key },
    });
    return c.json({ ok: true, mock: true });
  }
  const url = await createCheckoutSession({
    sku, site: SITE, returnHash: `/c/${comp.share_token}`,
    competitionId: comp.id, participantId: participant.id,
    adminId: buyer?.id ?? null, email: buyer?.email ?? null,
  });
  await logEvent("checkout_started", {
    competitionId: comp.id, participantId: participant.id,
    props: { sku, price: PRICES.answer_key },
  });
  return c.json({ url });
});

// Return path from Checkout. The webhook is authoritative, but a buyer can
// beat it back to the site; this grants through the same idempotent path so
// the feature is unlocked by the time the page repaints.
app.post("/api/checkout/:sessionId", async (c) => {
  if (!stripeEnabled()) return c.json({ ok: false, error: "not configured" });
  try {
    const r = await confirmSession(c.req.param("sessionId"));
    return c.json(r);
  } catch (e) {
    console.error("checkout confirm failed:", e);
    return c.json({ ok: false, error: "Could not confirm that payment." }, 502);
  }
});

// Stripe webhook. Must read the RAW body — parsing it first would break
// signature verification.
app.post("/stripe/webhook", async (c) => {
  const sig = c.req.header("stripe-signature") ?? "";
  const raw = await c.req.text();
  const r = await handleWebhook(raw, sig);
  return c.json(r.body, r.status as any);
});

// Legacy mock grant. Kept for the pre-Stripe client, but it hands out paid
// features for free, so it is refused the moment real payments are live.
app.post("/api/entitlements/grant", async (c) => {
  if (stripeEnabled()) return c.json({ error: "Use /api/checkout." }, 410);
  const b = await c.req.json().catch(() => ({}));
  const sku = String(b.sku ?? "");

  if (sku === "ultimate") {
    const admin = await requireAdmin(c);
    if (!admin) return c.json({ error: "unauthorized" }, 401);
    await sql`
      insert into entitlements (sku, admin_id, source) values ('ultimate', ${admin.id}, 'mock')
      on conflict (admin_id, sku) where sku = 'ultimate' do nothing`;
    await logEvent("purchase_mock", { adminId: admin.id, props: { sku, price: PRICES.ultimate } });
    return c.json({ ok: true, sku, price: PRICES.ultimate });
  }

  if (sku === "answer_key") {
    const compId = String(b.competition_id ?? "");
    const rows = await sql`select * from competitions where id = ${compId}`.catch(() => []);
    const comp = rows[0];
    if (!comp) return c.json({ error: "Competition not found." }, 404);
    const participant = await participantBySession(comp.id, c.req.header("x-pt"));
    if (!participant) return c.json({ error: "unauthorized" }, 401);
    // Eligibility: your own test attempt must be finished. This is the rule
    // that keeps answers away from anyone who hasn't played yet.
    const testAtt = await currentAttempt(participant.id, "wonderlic");
    if (testAtt?.status !== "finished") {
      return c.json({ error: "Finish your test first — then the key unlocks." }, 403);
    }
    await sql`
      insert into entitlements (sku, competition_id, granted_to_participant_id, source)
      values ('answer_key', ${comp.id}, ${participant.id}, 'mock')
      on conflict (granted_to_participant_id, sku) where sku = 'answer_key' do nothing`;
    await logEvent("purchase_mock", {
      competitionId: comp.id, participantId: participant.id,
      props: { sku, price: PRICES.answer_key },
    });
    return c.json({ ok: true, sku, price: PRICES.answer_key });
  }

  return c.json({ error: "Unknown sku." }, 400);
});

// Organizer's league-wide key view (Ultimate), once the competition is complete.
app.get("/api/admin/competition/:id/answer_key", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (!(await hasEntitlement(admin.id, "ultimate"))) return c.json({ error: "Requires Ultimate.", upsell: "ultimate" }, 403);
  if (!eventsFor(comp).includes("wonderlic")) return c.json({ error: "This competition has no test event." });
  const finished = await finishedCount(comp);
  if (comp.status !== "closed" && finished < comp.member_count) {
    return c.json({ error: "Available once the competition is complete.", pending: true });
  }
  const key = await buildAnswerKey(comp, { id: "00000000-0000-0000-0000-000000000000" });
  return c.json(key);
});

// ---------------- serve (normalize hosted path prefixes) ----------------

Deno.serve((req) => {
  const url = new URL(req.url);
  let p = url.pathname;
  if (p.startsWith("/functions/v1")) p = p.slice("/functions/v1".length);
  if (p === `/${FN}` || p.startsWith(`/${FN}/`)) p = p.slice(FN.length + 1) || "/";
  if (!p.startsWith("/")) p = "/" + p;
  const rewritten = new Request(url.origin + p + url.search, req);
  return app.fetch(rewritten);
});
