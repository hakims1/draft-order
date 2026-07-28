import { Hono } from "npm:hono@4.6.14";
import sql, { randomToken } from "./db.ts";
import { adminFromSession, createSession, destroySession, hashPassword, verifyPassword } from "./auth.ts";
import {
  bankQuestions,
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
  startAttempt,
  submitAnswer,
} from "./logic.ts";

const FN = "draftday";
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

async function memberState(c: any, comp: any, light = false) {
  await sweepExpired(comp);
  const ptoken = c.req.header("x-pt") || undefined;
  const participant = await participantBySession(comp.id, ptoken);
  const finished = await finishedCount(comp.id);
  const [{ joined }] = await sql`
    select count(*)::int as joined from participants
    where competition_id = ${comp.id} and not is_placeholder`;
  const visible = standingsVisible(comp, finished);
  const league = { name: comp.league_name, season_year: comp.season_year, member_count: comp.member_count };
  const displayCount = comp.type === "random_order" ? joined : finished;
  const payload: any = { type: comp.type, league, finished: displayCount };

  const attempt = participant ? await currentAttempt(participant.id) : null;
  const total = comp.config?.question_count ?? 30;
  if (attempt?.status === "finished") {
    payload.result = { score: Number(attempt.score), total, duration_ms: attempt.duration_ms };
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
    const rows = await sql`
      select p.display_name, a.score, a.duration_ms from attempts a
      join participants p on p.id = a.participant_id
      where p.competition_id = ${comp.id} and a.status = 'finished'
      order by a.score desc, a.duration_ms asc, a.finished_at asc`;
    return {
      leaderboard: rows.map((r: any, i: number) => ({
        rank: i + 1, name: r.display_name, score: Number(r.score), duration_ms: r.duration_ms,
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
  if (!attempt) {
    payload.phase = "ready";
    Object.assign(payload, await currentLeaderboard());
    return payload;
  }
  if (attempt.status === "finished") {
    payload.phase = "done";
    payload.timed_out = attempt.duration_ms != null && attempt.duration_ms >= (comp.config?.time_limit_seconds ?? 360) * 1000;
    return payload;
  }
  const ms = await remainingMs(attempt);
  if (ms <= 0) {
    await finalizeAttempt(attempt, comp, true);
    return await memberState(c, comp, light);
  }
  const st = attemptState(attempt);
  payload.phase = "question";
  payload.remaining_ms = ms;
  payload.current_index = st.current_index;
  payload.total = st.question_order.length;
  // Answer acks are light: the client already holds the full question set and
  // only needs the re-synced clock. Start/state responses carry everything so
  // the client never waits on the network between questions.
  if (!light) {
    const questions = await bankQuestions(comp.config?.bank_version ?? 1);
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
  return c.json({ ok: true, participant_token: res.participant.session_token });
});

app.post("/c/:token/start", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  if (!participant) return c.json({ phase: "error", error: "Join first." });
  if (comp.type === "wonderlic" && comp.status === "active") {
    await startAttempt(comp, participant);
  }
  return c.json(await memberState(c, comp));
});

app.post("/c/:token/answer", async (c) => {
  const comp = await competitionByShareToken(c.req.param("token"));
  if (!comp) return c.json({ phase: "error", error: "Competition not found." }, 404);
  const participant = await participantBySession(comp.id, c.req.header("x-pt"));
  const attempt = participant ? await currentAttempt(participant.id) : null;
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
  const finished = await finishedCount(comp.id);
  const visible = standingsVisible(comp, finished);
  return c.json({
    visible,
    finished,
    member_count: comp.member_count,
    league_name: comp.league_name,
    season_year: comp.season_year,
    type: comp.type,
    standings: visible ? await standings(comp) : null,
  });
});

// ---------------- admin auth ----------------

async function requireAdmin(c: any) {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return await adminFromSession(token);
}

app.post("/admin/signup", async (c) => {
  const { email: rawEmail, password } = await c.req.json().catch(() => ({}));
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!email.includes("@") || String(password ?? "").length < 8) {
    return c.json({ error: "Enter a valid email and a password of 8+ characters." });
  }
  const existing = await sql`select id from admins where email = ${email}`;
  if (existing.length) return c.json({ error: "That email already has an account. Log in instead." });
  const [admin] = await sql`
    insert into admins (email, password_hash) values (${email}, ${await hashPassword(String(password))})
    returning id`;
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
  const leagues: any[] = await sql`
    select * from leagues where admin_id = ${admin.id} order by created_at desc`;
  for (const l of leagues) {
    l.competitions = await sql`
      select id, type, status from competitions where league_id = ${l.id} order by created_at desc`;
  }
  return c.json({ email: admin.email, leagues });
});

app.post("/api/admin/leagues", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().slice(0, 60);
  const year = parseInt(b.season_year, 10);
  const members = parseInt(b.member_count, 10);
  if (!name) return c.json({ error: "Give the league a name." });
  if (!(year >= 2000 && year <= 2100)) return c.json({ error: "Season year looks wrong." });
  if (!(members >= 2 && members <= 64)) return c.json({ error: "Members must be between 2 and 64." });
  const [l] = await sql`
    insert into leagues (admin_id, name, season_year, member_count)
    values (${admin.id}, ${name}, ${year}, ${members}) returning id`;
  return c.json({ id: l.id });
});

async function ownedLeague(adminId: string, leagueId: string) {
  const rows = await sql`
    select * from leagues where id = ${leagueId} and admin_id = ${adminId}`.catch(() => []);
  return rows[0] ?? null;
}

app.get("/api/admin/league/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const league = await ownedLeague(admin.id, c.req.param("id"));
  if (!league) return c.json({ error: "not found" }, 404);
  const competitions = await sql`
    select id, type, status, created_at from competitions
    where league_id = ${league.id} order by created_at desc`;
  return c.json({ league, competitions });
});

app.post("/api/admin/league/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const league = await ownedLeague(admin.id, c.req.param("id"));
  if (!league) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const name = String(b.name ?? "").trim().slice(0, 60) || league.name;
  const year = parseInt(b.season_year, 10) || league.season_year;
  const members = parseInt(b.member_count, 10);
  const memberCount = members >= 2 && members <= 64 ? members : league.member_count;
  await sql`
    update leagues set name = ${name}, season_year = ${year}, member_count = ${memberCount}
    where id = ${league.id}`;
  return c.json({ ok: true });
});

app.post("/api/admin/league/:id/competitions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const league = await ownedLeague(admin.id, c.req.param("id"));
  if (!league) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const type = String(b.type) === "random_order" ? "random_order" : "wonderlic";
  const config = type === "wonderlic"
    ? { bank_version: 1, question_count: 30, time_limit_seconds: 360, max_attempts: 1 }
    : { max_attempts: 1 };
  const [comp] = await sql`
    insert into competitions (league_id, type, config)
    values (${league.id}, ${type}, ${JSON.stringify(config)}::jsonb) returning id`;
  return c.json({ id: comp.id });
});

async function ownedCompetition(adminId: string, compId: string) {
  const rows = await sql`
    select c.*, l.name as league_name, l.season_year, l.member_count, l.id as league_id
    from competitions c join leagues l on l.id = c.league_id
    where c.id = ${compId} and l.admin_id = ${adminId}`.catch(() => []);
  return rows[0] ?? null;
}

app.get("/api/admin/competition/:id", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  return c.json({
    competition: {
      id: comp.id, type: comp.type, status: comp.status, config: comp.config,
      share_token: comp.share_token, results_token: comp.results_token,
      activated_at: comp.activated_at, closed_at: comp.closed_at,
    },
    league: { id: comp.league_id, name: comp.league_name, season_year: comp.season_year, member_count: comp.member_count },
  });
});

app.post("/api/admin/competition/:id/activate", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (comp.status === "draft") {
    await sql`
      update competitions set status = 'active', activated_at = now(),
        share_token = ${randomToken(18)}, results_token = ${randomToken(18)}
      where id = ${comp.id}`;
  }
  return c.json({ ok: true });
});

app.post("/api/admin/competition/:id/close", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  if (comp.status === "active") await closeCompetition(comp.id);
  return c.json({ ok: true });
});

app.get("/api/admin/competition/:id/live", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return c.json({ error: "unauthorized" }, 401);
  const comp = await ownedCompetition(admin.id, c.req.param("id"));
  if (!comp) return c.json({ error: "not found" }, 404);
  await sweepExpired(comp);
  const rows = await sql`
    select p.display_name, p.real_name, p.is_dnf, a.status as astatus, a.score, a.duration_ms, a.started_at
    from participants p
    left join attempts a on a.participant_id = p.id
    where p.competition_id = ${comp.id}
    order by p.created_at`;
  const finished = await finishedCount(comp.id);
  return c.json({
    finished,
    member_count: comp.member_count,
    status: comp.status,
    participants: rows.map((r: any) => ({
      name: r.display_name,
      real_name: r.real_name,
      dnf: r.is_dnf,
      started: r.started_at != null,
      finished: r.astatus === "finished",
      score: r.astatus === "finished" && !r.is_dnf ? Number(r.score) : null,
      duration_ms: r.astatus === "finished" && !r.is_dnf ? r.duration_ms : null,
    })),
  });
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
