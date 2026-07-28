"use strict";
/* Draft Order Competition — SPA. API lives on a Supabase Edge Function. */
const API = "https://bwxsuybqhgocmwncxzlz.supabase.co/functions/v1/draftday";
const SITE = location.origin + location.pathname.replace(/index\.html$/, "");

const app = () => document.getElementById("app");
const wrap = () => document.getElementById("wrap");
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function fmtDur(ms) {
  if (ms == null) return "";
  const s = ms / 1000;
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") + "." + Math.floor((ms % 1000) / 100);
}

let timers = [];
function addTimer(t) { timers.push(t); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

/* ================= reveal (shared) ================= */
function renderReveal(el, standings, opts) {
  const showScore = !!opts.showScore;
  el.innerHTML =
    '<div class="row spread" style="margin-top:18px"><h2>Draft Order</h2>' +
    '<button class="btn ghost small" id="skipBtn">Skip</button></div>' +
    '<div id="slots">' +
    standings.map((r) =>
      '<div class="slot' + (r.rank === 1 ? " first" : "") + (r.dnf ? " dnf" : "") + '" data-rank="' + r.rank + '">' +
        '<div class="rank">' + r.rank + "</div>" +
        '<div class="who"><div class="nm">' + esc(r.name) + "</div>" +
        '<div class="meta">' + (r.dnf ? "DNF" : r.rank === 1 ? "First overall pick" : "Pick " + r.rank) + "</div></div>" +
        (showScore && !r.dnf
          ? '<div class="pts"><div class="s">' + r.score + '</div><div class="t">' + fmtDur(r.duration_ms) + "</div></div>"
          : "") +
      "</div>"
    ).join("") +
    "</div>" +
    (opts.shareUrl
      ? '<button class="btn ghost" id="shareBtn">Copy results link</button><div class="mut center" id="shareMsg" style="margin-top:8px"></div>'
      : "");

  const slots = Array.from(el.querySelectorAll(".slot")).sort((a, b) => b.dataset.rank - a.dataset.rank);
  let i = 0;
  const t = setInterval(() => {
    if (i >= slots.length) { clearInterval(t); return; }
    slots[i++].classList.add("on");
  }, 850);
  addTimer(t);
  $("#skipBtn", el).onclick = () => { clearInterval(t); slots.forEach((s) => s.classList.add("on")); };
  const sb = $("#shareBtn", el);
  if (sb) sb.onclick = async () => {
    try { await navigator.clipboard.writeText(opts.shareUrl); $("#shareMsg", el).textContent = "Link copied!"; }
    catch { $("#shareMsg", el).textContent = opts.shareUrl; }
  };
}

/* ================= member flow ================= */
function memberView(TOKEN) {
  let S = null, deadlinePerf = null, expiredNotified = false, selected = null, busy = false;
  let Q = null, total = 0, localIdx = 0, queue = Promise.resolve();
  const ptKey = "pt_" + TOKEN;

  const api = async (path, body) => {
    const headers = { "x-pt": localStorage.getItem(ptKey) || "" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(API + "/c/" + TOKEN + path, body !== undefined
      ? { method: "POST", headers, body: JSON.stringify(body) }
      : { headers });
    return await r.json();
  };

  function setState(next) {
    S = next;
    if (S.remaining_ms != null) { deadlinePerf = performance.now() + S.remaining_ms; expiredNotified = false; }
    if (S.phase === "question") {
      if (S.questions) { Q = S.questions; total = S.total; }
      // Never jump backwards: pending background submits mean the server's
      // index can lag the locally answered one.
      localIdx = Math.max(localIdx, S.current_index ?? 0);
    }
    render();
  }
  async function refresh() { try { setState(await api("/state.json")); } catch {} }
  function schedulePoll(ms) { const t = setInterval(refresh, ms); addTimer(t); }

  function tickClock() {
    const el = $("#clock");
    if (!el || deadlinePerf == null) return;
    const left = deadlinePerf - performance.now();
    el.textContent = fmtClock(left);
    el.classList.toggle("low", left < 60000);
    if (left <= 0 && !expiredNotified) { expiredNotified = true; refresh(); }
  }

  // Answer acks ride a background queue: the UI advances instantly and only
  // the clock re-sync (or a server-side finalization) comes back to us.
  function handleAck(r) {
    if (!r) return;
    if (r.phase && r.phase !== "question") { setState(r); return; }
    if (r.remaining_ms != null) { deadlinePerf = performance.now() + r.remaining_ms; expiredNotified = false; }
  }

  function renderQuestion() {
    clearTimers();
    const q = Q[localIdx];
    app().innerHTML =
      '<div style="text-align:left"><div class="testbar"><span class="qcount">Q ' + (localIdx + 1) + "/" + total + '</span><span class="clock" id="clock">--:--</span></div>' +
      '<div class="qprompt" id="qp">' + esc(q.prompt) + "</div>" +
      '<div class="opts" id="opts">' +
      q.options.map((o, i) =>
        '<button class="opt" data-i="' + i + '"><span class="key">' + "ABCD"[i] + "</span><span>" + esc(o) + "</span></button>"
      ).join("") +
      "</div>" +
      '<button class="btn" id="nextBtn" disabled>' + (localIdx + 1 === total ? "Submit test" : "Next") + "</button></div>";
    window.scrollTo(0, 0);
    selected = null;
    document.querySelectorAll(".opt").forEach((b) => {
      b.onclick = () => {
        selected = Number(b.dataset.i);
        document.querySelectorAll(".opt").forEach((x) => x.classList.toggle("sel", x === b));
        $("#nextBtn").disabled = false;
      };
    });
    $("#nextBtn").onclick = () => {
      if (selected == null) return;
      const pick = selected;
      queue = queue
        .then(() => api("/answer", { question_id: q.id, displayed_index: pick }))
        .then(handleAck)
        .catch(() => {});
      localIdx++;
      if (localIdx >= total) {
        clearTimers();
        app().innerHTML = '<div class="fade-in center" style="padding-top:80px"><h2>Locking in your answers&hellip;</h2></div>';
        window.scrollTo(0, 0);
        queue = queue.then(() => refresh());
        addTimer(setInterval(refresh, 3000)); // safety net if the final ack is lost
      } else {
        renderQuestion();
      }
    };
    tickClock();
    const t = setInterval(tickClock, 100);
    addTimer(t);
  }

  function render() {
    clearTimers();
    window.scrollTo(0, 0);
    const L = S.league;
    const isW = S.type === "wonderlic";

    if (S.phase === "join" || S.phase === "ready") {
      app().innerHTML =
        '<div class="fade-in" style="text-align:left"><div class="kicker">' + esc(L.name) + " &middot; " + L.season_year + '</div>' +
        "<h1>" + (isW ? "Draft Order<br>Cognitive Test" : "Random<br>Draft Order") + "</h1>" +
        '<div class="sub">' + (isW
          ? "30 questions &middot; 6 minutes &middot; highest score gets the first pick. Ties broken by speed."
          : "Enter your name. When all " + L.member_count + " members are locked in, the draft order is drawn.") + "</div>" +
        '<div class="card">' +
          '<div class="row spread"><span class="tag">' + (isW ? "Timed Test" : "Random Draw") + "</span>" +
          '<span class="mut">' + S.finished + " of " + L.member_count + (isW ? " finished" : " locked in") + "</span></div>" +
          (S.phase === "join"
            ? '<label for="nm">Display name</label><input id="nm" type="text" maxlength="40" placeholder="e.g. Big Mike" autocomplete="off">'
            : '<div class="sub">Welcome back, <b>' + esc(S.participant.name) + "</b>.</div>") +
          (isW
            ? '<div class="warnbox"><b>Heads up:</b> the 6:00 timer starts the instant you press the button below. It cannot be paused &mdash; closing the app, losing signal, or switching tabs will NOT stop it. One attempt only.</div>'
            : "") +
          '<button class="btn" id="goBtn">' + (isW ? "Start the test" : "Lock me in") + "</button>" +
          '<div class="err" id="joinErr"></div>' +
        "</div></div>";
      $("#goBtn").onclick = async () => {
        if (busy) return; busy = true; $("#goBtn").disabled = true;
        try {
          if (S.phase === "join") {
            const name = ($("#nm").value || "").trim();
            if (!name) { $("#joinErr").textContent = "Enter a name first."; return; }
            const j = await api("/join", { name });
            if (j.error) { $("#joinErr").textContent = j.error; return; }
            if (j.participant_token) localStorage.setItem(ptKey, j.participant_token);
          }
          setState(isW ? await api("/start", {}) : await api("/state.json"));
        } finally { busy = false; const b = $("#goBtn"); if (b) b.disabled = false; }
      };
      const nm = $("#nm");
      if (nm) nm.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#goBtn").click(); });
      return;
    }

    if (S.phase === "lobby") {
      app().innerHTML =
        '<div class="fade-in center"><div class="kicker">' + esc(L.name) + '</div>' +
        "<h1>You're locked in</h1>" +
        '<div class="card"><div class="bignum">' + S.finished + '<span style="color:var(--dim);font-size:40px">/' + L.member_count + "</span></div>" +
        '<div class="sub">members locked in. The order is drawn automatically when everyone is in.</div></div></div>';
      schedulePoll(4000);
      return;
    }

    if (S.phase === "question") {
      renderQuestion();
      return;
    }

    if (S.phase === "done") {
      app().innerHTML =
        '<div class="fade-in center"><div class="kicker">' + esc(L.name) + '</div>' +
        "<h1>" + (S.timed_out ? "Time!" : "Test complete") + "</h1>" +
        '<div class="card"><div class="mut">Your score</div>' +
        '<div class="bignum">' + S.result.score + '<span style="color:var(--dim);font-size:40px">/' + S.result.total + "</span></div>" +
        '<div class="sub">in ' + fmtDur(S.result.duration_ms) + "</div></div>" +
        '<div class="card"><div class="bignum" style="font-size:52px">' + S.finished + '<span style="color:var(--dim);font-size:30px">/' + L.member_count + "</span></div>" +
        '<div class="sub">members have finished. Standings unlock when everyone is done.</div></div></div>';
      schedulePoll(5000);
      return;
    }

    if (S.phase === "standings") {
      app().innerHTML =
        '<div class="fade-in" style="text-align:left"><div class="kicker">' + esc(L.name) + " &middot; " + L.season_year + '</div>' +
        "<h1>The results are in</h1>" +
        (S.result ? '<div class="sub">You scored ' + S.result.score + "/" + S.result.total + " in " + fmtDur(S.result.duration_ms) + ".</div>" : "") +
        '<div id="reveal"></div></div>';
      renderReveal($("#reveal"), S.standings, { showScore: S.type === "wonderlic", shareUrl: S.results_url });
      return;
    }

    app().innerHTML = '<div class="card">' + esc(S.error || "Competition unavailable.") + "</div>";
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && location.hash.includes(TOKEN)) refresh(); });
  refresh();
}

/* ================= results page ================= */
async function resultsView(TOKEN) {
  const r = await fetch(API + "/r/" + TOKEN + "/data.json").then((x) => x.json());
  if (!r.visible) {
    app().innerHTML = '<div class="card center"><h2>Not ready yet</h2><div class="sub">' + r.finished + " of " + r.member_count + " members have finished. Check back soon.</div></div>";
    addTimer(setInterval(() => resultsView(TOKEN), 8000));
    return;
  }
  clearTimers();
  app().innerHTML =
    '<div style="text-align:left"><div class="kicker">' + esc(r.league_name) + " &middot; " + r.season_year + '</div><h1>Official Draft Order</h1>' +
    '<div id="reveal"></div></div>';
  renderReveal($("#reveal"), r.standings, { showScore: r.type === "wonderlic", shareUrl: location.href });
}

/* ================= admin ================= */
const aapi = async (path, body, method) => {
  const headers = { authorization: "Bearer " + (localStorage.getItem("adm") || "") };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(API + path, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.hash = "#/admin"; renderLogin(); throw new Error("unauthorized"); }
  return await r.json();
};

function renderLogin(error, mode) {
  clearTimers();
  const isLogin = mode !== "signup";
  wrap().classList.remove("wide");
  app().innerHTML = `
    <div class="center" style="padding-top:30px">
      <div class="kicker">Commissioner HQ</div>
      <h1>Draft Order<br>Competition</h1>
    </div>
    <div class="card" style="text-align:left">
      <h2>${isLogin ? "Log in" : "Create account"}</h2>
      <label>Email</label>
      <input type="email" id="em" autocomplete="email">
      <label>Password</label>
      <input type="password" id="pw" autocomplete="${isLogin ? "current-password" : "new-password"}">
      <div class="err" id="authErr">${esc(error || "")}</div>
      <button class="btn" id="authBtn">${isLogin ? "Log in" : "Sign up"}</button>
      <div class="mut" style="margin-top:14px">
        ${isLogin ? 'New here? <a href="#" id="swap">Create an account</a>' : 'Already have an account? <a href="#" id="swap">Log in</a>'}
      </div>
    </div>`;
  $("#swap").onclick = (e) => { e.preventDefault(); renderLogin("", isLogin ? "signup" : "login"); };
  $("#authBtn").onclick = async () => {
    const r = await fetch(API + "/admin/" + (isLogin ? "login" : "signup"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("#em").value, password: $("#pw").value }),
    }).then((x) => x.json());
    if (r.error) { $("#authErr").textContent = r.error; return; }
    localStorage.setItem("adm", r.token);
    location.hash = "#/admin";
    adminHome();
  };
  $("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#authBtn").click(); });
}

async function adminHome() {
  clearTimers();
  if (!localStorage.getItem("adm")) return renderLogin();
  let d;
  try { d = await aapi("/api/admin/dashboard"); } catch { return; }
  wrap().classList.add("wide");
  const typeName = (t) => t === "wonderlic" ? "Wonderlic Test" : "Random Order";
  const statusTag = (s) => `<span class="tag ${s === "active" ? "" : s === "closed" ? "red" : "gray"}">${s}</span>`;
  app().innerHTML = `
    <div style="text-align:left">
    <div class="row spread" style="margin-top:10px">
      <div><div class="kicker">Commissioner HQ</div><h1>Your Leagues</h1></div>
      <button class="btn ghost small" id="logoutBtn">Log out</button>
    </div>
    <div class="mut">${esc(d.email)}</div>
    ${d.leagues.map((l) => `
      <div class="card">
        <div class="row spread">
          <div><h2>${esc(l.name)}</h2><div class="mut">${l.season_year} season · ${l.member_count} members</div></div>
          <a class="btn ghost small" href="#/admin/league/${l.id}">Manage</a>
        </div>
        ${l.competitions.map((c) => `
          <div class="row spread" style="margin-top:8px">
            <span>${typeName(c.type)} ${statusTag(c.status)}</span>
            <a href="#/admin/comp/${c.id}">Open →</a>
          </div>`).join("")}
      </div>`).join("") || '<div class="card mut">No leagues yet — create your first one below.</div>'}
    <div class="card">
      <h2>New league</h2>
      <label>League name</label><input type="text" id="lname" maxlength="60" placeholder="e.g. The Sunday Regrets">
      <label>Season year</label><input type="number" id="lyear" value="${new Date().getFullYear()}">
      <label>Number of members</label><input type="number" id="lmembers" value="12" min="2" max="64">
      <div class="err" id="lerr"></div>
      <button class="btn" id="lcreate">Create league</button>
    </div></div>`;
  $("#logoutBtn").onclick = () => { localStorage.removeItem("adm"); renderLogin(); };
  $("#lcreate").onclick = async () => {
    const r = await aapi("/api/admin/leagues", {
      name: $("#lname").value, season_year: Number($("#lyear").value), member_count: Number($("#lmembers").value),
    });
    if (r.error) { $("#lerr").textContent = r.error; return; }
    location.hash = "#/admin/league/" + r.id;
  };
}

async function leagueView(id) {
  clearTimers();
  let d;
  try { d = await aapi("/api/admin/league/" + id); } catch { return; }
  if (d.error) return adminHome();
  wrap().classList.add("wide");
  const l = d.league;
  const typeName = (t) => t === "wonderlic" ? "Wonderlic Test" : "Random Order";
  const statusTag = (s) => `<span class="tag ${s === "active" ? "" : s === "closed" ? "red" : "gray"}">${s}</span>`;
  app().innerHTML = `
    <div style="text-align:left">
    <div style="margin-top:10px"><a href="#/admin" class="mut">← Dashboard</a></div>
    <div class="kicker" style="margin-top:10px">${l.season_year} season</div>
    <h1>${esc(l.name)}</h1>
    <div class="card">
      <h2>League settings</h2>
      <label>League name</label><input type="text" id="lname" value="${esc(l.name)}" maxlength="60">
      <label>Season year</label><input type="number" id="lyear" value="${l.season_year}">
      <label>Number of members (competition slots)</label><input type="number" id="lmembers" value="${l.member_count}" min="2" max="64">
      <div class="okmsg" id="lmsg"></div>
      <button class="btn ghost" id="lsave">Save changes</button>
    </div>
    <div class="card">
      <h2>Competitions</h2>
      ${d.competitions.map((c) => `
        <div class="row spread" style="margin-top:10px">
          <div>${typeName(c.type)} ${statusTag(c.status)}</div>
          <a class="btn ghost small" href="#/admin/comp/${c.id}">Open</a>
        </div>`).join("") || '<div class="mut">None yet.</div>'}
      <label style="margin-top:16px">New competition type</label>
      <select id="ctype">
        <option value="wonderlic">Wonderlic-style timed test</option>
        <option value="random_order">Random order generator</option>
      </select>
      <button class="btn" id="ccreate">Create competition</button>
    </div></div>`;
  $("#lsave").onclick = async () => {
    await aapi("/api/admin/league/" + id, {
      name: $("#lname").value, season_year: Number($("#lyear").value), member_count: Number($("#lmembers").value),
    });
    $("#lmsg").textContent = "Saved.";
  };
  $("#ccreate").onclick = async () => {
    const r = await aapi("/api/admin/league/" + id + "/competitions", { type: $("#ctype").value });
    location.hash = "#/admin/comp/" + r.id;
  };
}

async function compView(id) {
  clearTimers();
  let d;
  try { d = await aapi("/api/admin/competition/" + id); } catch { return; }
  if (d.error) return adminHome();
  wrap().classList.add("wide");
  const c = d.competition, l = d.league;
  const typeName = c.type === "wonderlic" ? "Wonderlic Test" : "Random Order";
  const shareUrl = c.share_token ? SITE + "#/c/" + c.share_token : null;
  const resultsUrl = c.results_token ? SITE + "#/r/" + c.results_token : null;

  let block;
  if (c.status === "draft") {
    block = `
      <div class="card">
        <h2>Ready to launch</h2>
        <div class="mut">Pressing Begin activates the competition and generates the public share link for your group chat.</div>
        <button class="btn" id="beginBtn">Begin competition</button>
      </div>`;
  } else {
    block = `
      <div class="card">
        <div class="row spread"><h2>Share link</h2><button class="btn ghost small" data-copy="${esc(shareUrl)}">Copy link</button></div>
        <div class="linkbox">${esc(shareUrl)}</div>
        <div class="row spread" style="margin-top:16px"><h2>Results link (read-only)</h2><button class="btn ghost small" data-copy="${esc(resultsUrl)}">Copy link</button></div>
        <div class="linkbox">${esc(resultsUrl)}</div>
      </div>
      <div class="card">
        <div class="row spread"><h2>Live status</h2><span class="tag" id="liveCount">…</span></div>
        <table><thead><tr><th>Member</th><th>Status</th><th>Score</th><th>Time</th></tr></thead>
        <tbody id="liveBody"><tr><td colspan="4" class="mut">Loading…</td></tr></tbody></table>
        ${c.status === "active" ? `
        <button class="btn danger" id="closeBtn">Close competition now</button>
        <div class="modal-bg" id="modalBg"><div class="modal">
          <h2>Close competition?</h2>
          <div class="mut" style="margin-top:8px">Anyone who hasn't started will be marked DNF and ranked last. This triggers the final reveal for everyone. This cannot be undone.</div>
          <button class="btn danger" id="confirmClose">Yes, close it</button>
          <button class="btn ghost" id="cancelClose">Cancel</button>
        </div></div>` : `<div class="okmsg" style="margin-top:12px">Competition closed. <a href="${resultsUrl}">View the reveal →</a></div>`}
      </div>`;
  }

  app().innerHTML = `
    <div style="text-align:left">
    <div style="margin-top:10px"><a href="#/admin/league/${l.id}" class="mut">← ${esc(l.name)}</a></div>
    <div class="kicker" style="margin-top:10px">${esc(l.name)} · ${l.season_year}</div>
    <h1>${typeName}</h1>
    <div class="row" style="margin-top:6px"><span class="tag ${c.status === "active" ? "" : c.status === "closed" ? "red" : "gray"}">${c.status}</span>
    <span class="mut">${c.type === "wonderlic" ? "30 questions · 6:00 · ties broken by speed" : "Order drawn when all members lock in"}</span></div>
    ${block}</div>`;

  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy link"), 1500); } catch {}
    };
  });
  if (c.status === "draft") {
    $("#beginBtn").onclick = async () => { await aapi("/api/admin/competition/" + id + "/activate", {}); compView(id); };
    return;
  }
  if (c.status === "active") {
    $("#closeBtn").onclick = () => $("#modalBg").classList.add("open");
    $("#cancelClose").onclick = () => $("#modalBg").classList.remove("open");
    $("#confirmClose").onclick = async () => { await aapi("/api/admin/competition/" + id + "/close", {}); compView(id); };
  }
  async function poll() {
    try {
      const r = await aapi("/api/admin/competition/" + id + "/live");
      const lc = $("#liveCount");
      if (!lc) return;
      lc.textContent = r.finished + " of " + r.member_count + " complete";
      $("#liveBody").innerHTML = r.participants.map((p) =>
        "<tr><td>" + esc(p.name) + "</td>" +
        "<td>" + (p.dnf ? '<span class="tag red">DNF</span>' : p.finished ? '<span class="tag green">Finished</span>' : p.started ? '<span class="tag">In test</span>' : '<span class="tag gray">Joined</span>') + "</td>" +
        "<td>" + (p.score ?? "&mdash;") + "</td>" +
        "<td>" + (p.duration_ms != null ? fmtDur(p.duration_ms) : "&mdash;") + "</td></tr>"
      ).join("") || '<tr><td colspan="4" class="mut">No one has joined yet.</td></tr>';
    } catch {}
  }
  poll();
  addTimer(setInterval(poll, 3000));
}

/* ================= router ================= */
function route() {
  clearTimers();
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/c\/([\w-]+)/))) return memberView(m[1]);
  if ((m = h.match(/^#\/r\/([\w-]+)/))) return resultsView(m[1]);
  if ((m = h.match(/^#\/admin\/league\/([\w-]+)/))) return leagueView(m[1]);
  if ((m = h.match(/^#\/admin\/comp\/([\w-]+)/))) return compView(m[1]);
  return adminHome();
}
window.addEventListener("hashchange", route);
route();
