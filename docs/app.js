"use strict";
/* Draft Order Competition — SPA. API lives on a Supabase Edge Function. */
const API = "https://bwxsuybqhgocmwncxzlz.supabase.co/functions/v1/draftday";
const SITE = location.origin + location.pathname.replace(/index\.html$/, "");

const app = () => document.getElementById("app");
const landingEl = () => document.getElementById("landing");
let landingWired = false;

/* Display names only — the enum values in the DB/API are unchanged. */
const TYPE_NAME = (t) =>
  t === "wonderlic" ? "Draft Day Aptitude Test" : t === "trex" ? "T-Rex Runner" : "Random Order";

/* Group-chat messages. Shared by the landing preview and the live share card. */
const MSGS_TEST = [
  "Yooooo\n\nso instead of pulling names out of a stupid hat this year, how about we compete for our draft picks\n\n6 minute test, 30 questions, everyone gets 1 try. highest score picks first. whoever finishes last picks 12th and has to live with it\n\ndo it whenever you want, it's on your phone. link below",
  "new rule for this year\n\nno hat, no randomizer. we're competing for our picks\n\n6 min test. 30 questions. 1 try each. highest score picks first, last place picks last\n\nlet's find out who actually knows anything in this group",
  "draft order is a competition this year. 6 min test, 1 try each, highest score picks first. no hat, no randomizer. takes six minutes on your phone, link below"
];
const MSGS_DRAW = [
  "Yooooo\n\ndraft order is getting drawn on a link this year instead of somebody's kitchen table\n\neveryone taps it and locks their name in. the second the last person is in, the order draws itself and we all see it at the same time\n\ntakes ten seconds, do it whenever. link below",
  "new rule for this year\n\nno hat, no arguing about who watched the draw. everyone locks in on the link and the order pops the moment the last name is in\n\nwhatever it spits out is the board. no re-rolls",
  "draft order draw is happening on this link. lock your name in, order gets drawn once everyone's in, everybody sees it live. ten seconds"
];
const MSGS_TREX = [
  "Yooooo\n\ndraft order this year = the dinosaur game. yes, that one\n\neveryone gets 3 practice runs then 1 run that counts. highest score picks first, last place lives with it\n\ntakes five minutes on your phone, link below",
  "new rule for this year\n\nno hat, no randomizer. draft order is decided by the dino runner\n\n3 practice runs, then 1 real one. highest score picks first, last place picks last\n\nwarm up first. you'll need it",
  "draft order = dino game this year. 3 practice runs, 1 that counts, highest score picks first. five minutes on your phone, link below"
];
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

/* ================= shared row builders ================= */
function lbRowsHtml(rows, showScore) {
  return rows.map((r) =>
    '<div class="lb-row' + (r.rank === 1 ? " top" : "") + '"><span class="rk">' + r.rank + "</span>" +
    '<span class="nm">' + esc(r.name) +
      (r.real_name ? '<span class="rn">' + esc(r.real_name) + "</span>" : "") + "</span>" +
    (showScore && r.score != null
      ? '<span class="sc">' + r.score + '</span><span class="tm">' + fmtDur(r.duration_ms) + "</span>"
      : "") +
    "</div>"
  ).join("");
}

/* Generic paywall modal — driven entirely by server-supplied copy so
   experiments can change messaging without a frontend deploy. */
function showPaywall(p) {
  const bg = document.createElement("div");
  bg.className = "modal-bg open";
  bg.innerHTML =
    '<div class="modal"><div class="kicker">Premium</div>' +
    "<h2>" + esc(p.title) + "</h2>" +
    '<div class="mut" style="margin-top:8px">' + esc(p.message) + "</div>" +
    '<button class="btn" disabled title="Payments coming soon">' + esc(p.cta) + "</button>" +
    '<div class="mut center" style="margin-top:8px;font-size:12px">Payments aren&#39;t live yet.</div>' +
    '<button class="btn ghost" id="pwClose">Not now</button></div>';
  document.body.appendChild(bg);
  bg.querySelector("#pwClose").onclick = () => bg.remove();
}

function missedCardHtml(S) {
  if (S.missed_locked && S.missed_paywall) {
    const p = S.missed_paywall;
    return '<div class="card" style="text-align:left"><h2>' + esc(p.title) + "</h2>" +
      '<div class="sub">' + esc(p.message) + "</div>" +
      '<button class="btn ghost" disabled title="Payments coming soon">' + esc(p.cta) + "</button></div>";
  }
  if (!S.result || !S.missed) return "";
  if (!S.missed.length) {
    return '<div class="card" style="text-align:left"><h2>Perfect sheet</h2><div class="sub">You missed nothing.</div></div>';
  }
  return '<div class="card" style="text-align:left"><h2>What you missed</h2>' +
    '<div class="mut" style="margin-top:4px">' + S.missed.length + " question" + (S.missed.length === 1 ? "" : "s") + " &mdash; only you can see this.</div>" +
    S.missed.map((m) =>
      '<div class="miss"><div class="miss-q">' + esc(m.prompt) + "</div>" +
      '<div class="miss-a">Your answer: ' + (m.your_answer != null ? esc(m.your_answer) : "no answer (time ran out)") + "</div>" +
      '<div class="miss-c">Correct answer: ' + esc(m.correct_answer) + "</div></div>"
    ).join("") + "</div>";
}

/* Viral CTA: invited members can spin up their own league. Tracks the click
   and carries the source competition through signup for attribution. */
function ctaCardHtml(small) {
  return small
    ? '<button class="btn ghost" data-cta="1">Start your own competition</button>'
    : '<div class="card"><div class="kicker">Your league next?</div>' +
      '<button class="btn" data-cta="1">Start your own competition</button>' +
      '<div class="mut center" style="margin-top:8px">Free &middot; set up in two minutes</div></div>';
}
function wireCta(shareToken) {
  document.querySelectorAll("[data-cta]").forEach((b) => {
    b.onclick = () => {
      try { localStorage.setItem("ref_share", shareToken); } catch {}
      fetch(API + "/track", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "cta_start_own_clicked", share_token: shareToken }),
      }).catch(() => {});
      location.hash = "#/admin/signup";
    };
  });
}

/* ================= t-rex runner embed (vendored Chromium dino, BSD) ================= */
let trexLoaded = null;
function loadTrexAssets() {
  if (trexLoaded) return trexLoaded;
  trexLoaded = fetch("./trex/index.html").then(function (r) { return r.text(); }).then(function (html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var holder = document.createElement("div");
    holder.id = "trexResources";
    holder.style.display = "none";
    var imgs = doc.getElementById("offline-resources");
    if (imgs) {
      imgs.querySelectorAll("img").forEach(function (i) { i.setAttribute("src", "trex/" + i.getAttribute("src")); });
      holder.appendChild(document.importNode(imgs, true));
    }
    var audio = doc.getElementById("audio-resources");
    if (audio) holder.appendChild(document.importNode(audio, true));
    // Runner.init/setArcadeMode expect these interstitial elements to exist.
    var icon = document.createElement("div");
    icon.className = "icon icon-offline";
    holder.appendChild(icon);
    document.body.appendChild(holder);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "trex/index.js";
      s.onload = res;
      s.onerror = rej;
      document.body.appendChild(s);
    });
  }).then(function () {
    // Neutralize Chrome's fullscreen "arcade mode": on game start the stock
    // code applies scale()+translateY() (multiplied by devicePixelRatio) to
    // take over the whole page — inside our card that throws the canvas out
    // of view, worst on retina phones. The game plays fine without it.
    Runner.prototype.setArcadeMode = function () {};
    Runner.prototype.setArcadeModeContainerScale = function () {};
    // Emit a crash event carrying the displayed score.
    var orig = Runner.prototype.gameOver;
    Runner.prototype.gameOver = function () {
      orig.call(this);
      var score = this.distanceMeter.getActualDistance(Math.ceil(this.distanceRan));
      window.dispatchEvent(new CustomEvent("trex:crash", { detail: { score: score } }));
    };
  });
  return trexLoaded;
}

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
  let Q = null, total = 0, localIdx = 0, queue = Promise.resolve(), lastPhase = null;
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
    // Poll updates on the done screen patch the leaderboard in place — a full
    // re-render would reset the reader's scroll position every 5 seconds.
    if (S.phase === "done" && lastPhase === "done" && $("#lbWrap")) {
      const lb = S.leaderboard || [];
      $("#lbWrap").innerHTML = lb.length
        ? lbRowsHtml(lb, true)
        : '<div class="mut" style="margin-top:10px">No other scores yet.</div>';
      const lc = $("#lbCount");
      if (lc) lc.textContent = S.finished + " of " + S.league.member_count + " finished";
      return;
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

  /* ---- t-rex game phase ---- */
  let dino = null, crashArmed = false;

  function gameHeader() {
    const runIdx = S.run_index;
    const isReal = runIdx >= S.practice_runs;
    return '<div class="row spread" style="margin-top:10px"><span class="tag' + (isReal ? " red" : "") + '">' +
      (isReal ? "The real run" : "Practice " + (runIdx + 1) + " of " + S.practice_runs) + "</span>" +
      '<span class="mut"><span id="clock" class="clock sm">--:--</span> session left</span></div>';
  }

  function armCrash() {
    if (crashArmed) return;
    crashArmed = true;
    window.addEventListener("trex:crash", function (e) {
      if (!location.hash.includes(TOKEN)) return;
      const score = Math.round(e.detail.score);
      queue = queue
        .then(function () { return api("/run", { score: score }); })
        .then(function (r) { handleRunAck(r, score); })
        .catch(function () {});
    });
  }

  function handleRunAck(r, score) {
    if (!r) return;
    if (r.phase !== "game") { setState(r); return; }
    S = r;
    if (r.remaining_ms != null) { deadlinePerf = performance.now() + r.remaining_ms; expiredNotified = false; }
    const head = $("#gameHead");
    if (head) head.innerHTML = gameHeader();
    const isRealNext = r.run_index >= r.practice_runs;
    const msg = $("#runMsg"), btn = $("#runBtn");
    if (!msg || !btn) return;
    msg.innerHTML = "Run over &mdash; you scored <b>" + score + "</b>." +
      (isRealNext ? ' <b style="color:var(--danger)">Next one counts.</b>' : " " + (r.practice_runs - r.run_index) + " practice run" + (r.practice_runs - r.run_index === 1 ? "" : "s") + " left.");
    btn.style.display = "block";
    btn.className = "btn" + (isRealNext ? " danger" : "");
    btn.textContent = isRealNext ? "Start the real run" : "Start practice " + (r.run_index + 1);
    btn.onclick = function () {
      btn.style.display = "none";
      msg.innerHTML = isRealNext
        ? '<b style="color:var(--danger)">This run counts.</b> Tap the game (or press Space) to jump.'
        : "Tap the game (or press Space) to jump. Run ends when you crash.";
      if (dino) dino.restart();
    };
  }

  function renderGame() {
    clearTimers();
    if (lastPhase !== "game") window.scrollTo(0, 0);
    lastPhase = "game";
    app().innerHTML =
      '<div class="game-screen" style="text-align:left"><div><div class="kicker">' + esc(S.league.name) + '</div>' +
      '<h1 style="font-size:30px">T-Rex Run-Off</h1>' +
      '<div id="gameHead">' + gameHeader() + "</div></div>" +
      '<div class="trex-stage"><div id="trexCont"></div></div>' +
      '<div class="card"><div class="sub" id="runMsg">Loading the game&hellip;</div>' +
      '<button class="btn" id="runBtn" style="display:none"></button></div></div>';
    tickClock();
    addTimer(setInterval(tickClock, 1000));
    loadTrexAssets().then(function () {
      if (window.__dino && window.__dino.stopListening) { try { window.__dino.stopListening(); } catch (e) {} }
      Runner.instance_ = null;
      dino = window.__dino = new Runner("#trexCont");
      armCrash();
      const isReal = S.run_index >= S.practice_runs;
      $("#runMsg").innerHTML = isReal
        ? '<b style="color:var(--danger)">This run counts.</b> Tap the game (or press Space) to jump and start.'
        : "Tap the game (or press Space) to jump and start practice run " + (S.run_index + 1) + ". Run ends when you crash.";
    }).catch(function () {
      const m = $("#runMsg");
      if (m) m.textContent = "Couldn't load the game — check your connection and refresh.";
    });
  }

  function render() {
    clearTimers();
    // Scroll to top only on phase transitions — periodic re-renders (leaderboard
    // polling) must not yank the reader back up.
    if (lastPhase !== S.phase) window.scrollTo(0, 0);
    lastPhase = S.phase;
    const L = S.league;
    const isW = S.type === "wonderlic";
    const isT = S.type === "trex";

    if (S.phase === "join" || S.phase === "ready") {
      // Preserve any half-typed names across re-renders (e.g. visibility refresh).
      const prevNm = $("#nm") ? $("#nm").value : "";
      const prevRn = $("#rn") ? $("#rn").value : "";

      const rules = isW
        ? '<div class="rules">' +
            '<div class="rule"><span class="ico">&#9670;</span><span><span class="gold">30 questions</span> &middot; <span class="gold">6:00</span> on the clock</span></div>' +
            '<div class="rule"><span class="ico">&#9670;</span><span>Highest score gets to choose their <span class="gold">preferred draft slot</span></span></div>' +
            '<div class="rule"><span class="ico">&#9670;</span><span>Ties are decided by <span class="gold">completion time</span></span></div>' +
          "</div>"
        : isT
        ? '<div class="rules">' +
            '<div class="rule"><span class="ico">&#9670;</span><span><span class="gold">3 practice runs</span>, then <span class="gold">1 run that counts</span></span></div>' +
            '<div class="rule"><span class="ico">&#9670;</span><span>Jump the cacti &mdash; survive longer, <span class="gold">score higher</span></span></div>' +
            '<div class="rule"><span class="ico">&#9670;</span><span>Highest score gets to choose their <span class="gold">preferred draft slot</span></span></div>' +
          "</div>"
        : '<div class="rules">' +
            '<div class="rule"><span class="ico">&#9670;</span><span>All <span class="gold">' + L.member_count + ' names</span> go into the draw</span></div>' +
            '<div class="rule"><span class="ico">&#9670;</span><span>The order is drawn the moment the <span class="gold">last member locks in</span></span></div>' +
          "</div>";

      let lbCard = "";
      if (isW || isT) {
        const lb = S.leaderboard || [];
        lbCard =
          '<div class="card"><div class="row spread"><h2>Leaderboard</h2>' +
          '<span class="mut">' + S.finished + " of " + L.member_count + " finished</span></div>" +
          (lb.length
            ? lbRowsHtml(lb, true)
            : '<div class="mut" style="margin-top:10px">No scores yet &mdash; be the first on the board.</div>') +
          "</div>";
      } else if (S.roster) {
        lbCard =
          '<div class="card"><div class="row spread"><h2>Locked in</h2>' +
          '<span class="mut">' + S.finished + " of " + L.member_count + "</span></div>" +
          (S.roster.length
            ? S.roster.map((n, i) =>
                '<div class="lb-row"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(n) + "</span></div>").join("")
            : '<div class="mut" style="margin-top:10px">Nobody yet &mdash; get in first.</div>') +
          "</div>";
      }

      app().innerHTML =
        '<div class="fade-in" style="text-align:left"><div class="kicker">' + esc(L.name) + '</div>' +
        "<h1>" + (isW ? "Draft Order<br>Cognitive Test" : isT ? "T-Rex<br>Run-Off" : "Random<br>Draft Order") + "</h1>" +
        rules +
        '<div class="card">' +
          '<div class="row spread"><span class="tag">' + (isW ? "Timed Test" : isT ? "Game of Skill" : "Random Draw") + "</span></div>" +
          (S.phase === "join"
            ? '<label for="nm">Display name</label><input id="nm" type="text" maxlength="40" placeholder="e.g. Big Mike" autocomplete="off">' +
              '<label for="rn">Your actual name</label><input id="rn" type="text" maxlength="60" placeholder="So the commissioner knows it&#39;s you" autocomplete="name">'
            : '<div class="sub">Welcome back, <b>' + esc(S.participant.name) + "</b>.</div>") +
          (isW
            ? '<div class="warnbox"><b>Heads up:</b> the 6:00 timer starts the instant you press the button below. It cannot be paused &mdash; closing the app, losing signal, or switching tabs will NOT stop it. One attempt only.</div>'
            : isT
            ? '<div class="warnbox"><b>One sitting:</b> pressing the button starts your session &mdash; 3 practice runs, then the real one, back-to-back with a 15:00 session limit. One attempt only.</div>'
            : "") +
          '<button class="btn" id="goBtn">' + (isW ? "Start the test" : isT ? "Start playing" : "Lock me in") + "</button>" +
          '<div class="err" id="joinErr"></div>' +
        "</div>" +
        lbCard + "</div>";

      const nm = $("#nm"), rn = $("#rn");
      if (nm && prevNm) nm.value = prevNm;
      if (rn && prevRn) rn.value = prevRn;
      $("#goBtn").onclick = async () => {
        if (busy) return; busy = true; $("#goBtn").disabled = true;
        try {
          if (S.phase === "join") {
            const name = ($("#nm").value || "").trim();
            const realName = ($("#rn").value || "").trim();
            if (!name) { $("#joinErr").textContent = "Enter a display name first."; return; }
            if (!realName) { $("#joinErr").textContent = "Enter your actual name too."; return; }
            const j = await api("/join", { name, real_name: realName });
            if (j.error) { $("#joinErr").textContent = j.error; return; }
            if (j.participant_token) localStorage.setItem(ptKey, j.participant_token);
          }
          setState(isW || isT ? await api("/start", {}) : await api("/state.json"));
        } finally { busy = false; const b = $("#goBtn"); if (b) b.disabled = false; }
      };
      if (nm) nm.addEventListener("keydown", (e) => { if (e.key === "Enter" && rn) rn.focus(); });
      if (rn) rn.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#goBtn").click(); });
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

    if (S.phase === "game") {
      renderGame();
      return;
    }

    if (S.phase === "done") {
      const lb = S.leaderboard || [];
      app().innerHTML =
        '<div class="fade-in center"><div class="kicker">' + esc(L.name) + '</div>' +
        "<h1>" + (S.timed_out ? "Time!" : "Test complete") + "</h1>" +
        '<div class="card"><div class="mut">Your score</div>' +
        '<div class="bignum">' + S.result.score + (S.result.total ? '<span style="color:var(--dim);font-size:40px">/' + S.result.total + "</span>" : "") + "</div>" +
        '<div class="sub">in ' + fmtDur(S.result.duration_ms) + "</div></div>" +
        missedCardHtml(S) +
        ctaCardHtml() +
        '<div class="card" style="text-align:left"><div class="row spread"><h2>Leaderboard</h2>' +
        '<span class="mut" id="lbCount">' + S.finished + " of " + L.member_count + ' finished</span></div>' +
        '<div id="lbWrap">' +
        (lb.length ? lbRowsHtml(lb, true) : '<div class="mut" style="margin-top:10px">No other scores yet.</div>') +
        "</div>" +
        '<div class="mut" style="margin-top:12px">The full draft order reveal unlocks when everyone is done.</div></div></div>';
      wireCta(TOKEN);
      schedulePoll(5000);
      return;
    }

    if (S.phase === "standings") {
      app().innerHTML =
        '<div class="fade-in" style="text-align:left"><div class="kicker">' + esc(L.name) + '</div>' +
        "<h1>The results are in</h1>" +
        (S.result ? '<div class="sub">You scored ' + S.result.score + (S.result.total ? "/" + S.result.total : "") + " in " + fmtDur(S.result.duration_ms) + ".</div>" : "") +
        '<div id="reveal"></div>' + missedCardHtml(S) + ctaCardHtml(true) + "</div>";
      renderReveal($("#reveal"), S.standings, { showScore: S.type === "wonderlic", shareUrl: S.results_url });
      wireCta(TOKEN);
      return;
    }

    app().innerHTML = '<div class="card">' + esc(S.error || "Competition unavailable.") + "</div>";
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && location.hash.includes(TOKEN)) refresh(); });
  refresh();
}

/* ================= results page ================= */
async function resultsView(TOKEN) {
  let r;
  try { r = await fetch(API + "/r/" + TOKEN + "/data.json").then((x) => x.json()); }
  catch { addTimer(setInterval(() => resultsView(TOKEN), 8000)); return; }
  if (r.error) {
    clearTimers();
    app().innerHTML = '<div class="card center"><h2>Link not found</h2></div>';
    return;
  }
  clearTimers();
  if (!r.visible) {
    // Not final yet: live standings that keep updating until the reveal.
    const showScore = r.type === "wonderlic";
    const rows = (r.standings || []).filter((s) => !s.dnf);
    app().innerHTML =
      '<div style="text-align:left"><div class="kicker">' + esc(r.league_name) + '</div>' +
      "<h1>Live Standings</h1>" +
      '<div class="sub">' + r.finished + " of " + r.member_count + " members have finished &middot; this page updates automatically</div>" +
      '<div class="card">' +
      (rows.length ? lbRowsHtml(rows, showScore) : '<div class="mut">Nobody has finished yet.</div>') +
      "</div></div>";
    addTimer(setInterval(() => resultsView(TOKEN), 6000));
    return;
  }
  app().innerHTML =
    '<div style="text-align:left"><div class="kicker">' + esc(r.league_name) + '</div><h1>Official Draft Order</h1>' +
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
    const body = { email: $("#em").value, password: $("#pw").value };
    if (!isLogin) body.ref = localStorage.getItem("ref_share") || undefined;
    const r = await fetch(API + "/admin/" + (isLogin ? "login" : "signup"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.error) { $("#authErr").textContent = r.error; return; }
    localStorage.setItem("adm", r.token);
    localStorage.removeItem("ref_share");
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
  const typeName = TYPE_NAME;
  const statusTag = (s) => `<span class="tag ${s === "active" ? "" : s === "closed" ? "red" : "gray"}">${s}</span>`;
  app().innerHTML = `
    <div style="text-align:left">
    <div class="row spread" style="margin-top:10px">
      <div><div class="kicker">Commissioner HQ</div><h1>Your Leagues</h1></div>
      <div class="row">${d.is_owner ? '<a class="btn ghost small" href="#/admin/metrics">Business metrics</a>' : ""}
      <button class="btn ghost small" id="logoutBtn">Log out</button></div>
    </div>
    <div class="mut">${esc(d.email)}</div>
    ${d.competitions.map((k) => `
      <div class="card">
        <div class="row spread">
          <div><h2>${esc(k.name)}</h2><div class="mut">${k.member_count} members · ${typeName(k.type)} ${statusTag(k.status)}</div></div>
          <a class="btn ghost small" href="#/admin/comp/${k.id}">Manage</a>
        </div>
      </div>`).join("") || '<div class="card mut">No competitions yet — set one up below.</div>'}
    <div class="card">
      <h2>New competition</h2>
      <label>Game type</label>
      <select id="ctype">
        <option value="wonderlic">Draft Day Aptitude Test — 30 questions, 6 minutes</option>
        <option value="trex">T-Rex Runner — game of skill</option>
        <option value="random_order">Random order draw</option>
      </select>
      <label>League name</label><input type="text" id="lname" maxlength="60" placeholder="e.g. The Sunday Regrets">
      <label>Number of members</label><input type="number" id="lmembers" value="12" min="2" max="64">
      <div class="err" id="lerr"></div>
      <button class="btn" id="lcreate">Create competition</button>
    </div></div>`;
  $("#logoutBtn").onclick = () => { localStorage.removeItem("adm"); renderLogin(); };
  $("#lcreate").onclick = async () => {
    const r = await aapi("/api/admin/competitions", {
      type: $("#ctype").value, name: $("#lname").value, member_count: Number($("#lmembers").value),
    });
    if (r.error) { $("#lerr").textContent = r.error; return; }
    location.hash = "#/admin/comp/" + r.id;
  };
}

async function compView(id) {
  clearTimers();
  let d;
  try { d = await aapi("/api/admin/competition/" + id); } catch { return; }
  if (d.error) return adminHome();
  wrap().classList.add("wide");
  const c = d.competition;
  const typeName = TYPE_NAME(c.type);
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
    const msgs = c.type === "random_order" ? MSGS_DRAW : c.type === "trex" ? MSGS_TREX : MSGS_TEST;
    const shareCard = shareUrl ? `
      <div class="card">
        <h2>The group chat message</h2>
        <div class="mut" style="margin-top:4px">Written to be pasted, not admired. Your live link is already on the end of it.</div>
        <div class="row" style="margin-top:14px">
          <button class="btn ghost small sel" data-share-tone="0">How you'd text it</button>
          <button class="btn ghost small" data-share-tone="1">Harder</button>
          <button class="btn ghost small" data-share-tone="2">Short</button>
        </div>
        <div id="shareBubble" style="white-space:pre-line;background:#1F3A63;color:#EDF1FA;border-radius:19px 19px 19px 5px;padding:13px 16px;margin-top:14px;font-size:16px;line-height:1.5;word-break:break-word">${esc(msgs[0] + "\n\n" + shareUrl)}</div>
        <button class="btn" id="shareCopyBtn" data-copy="${esc(msgs[0] + "\n\n" + shareUrl)}" data-copy-label="Copy message">Copy message</button>
      </div>` : "";
    block = shareCard + `
      <div class="card">
        <div class="row spread"><h2>Share link</h2><button class="btn ghost small" data-copy="${esc(shareUrl)}">Copy link</button></div>
        <div class="linkbox">${esc(shareUrl)}</div>
        <div class="row spread" style="margin-top:16px"><h2>Results link (read-only)</h2><button class="btn ghost small" data-copy="${esc(resultsUrl)}">Copy link</button></div>
        <div class="linkbox">${esc(resultsUrl)}</div>
      </div>
      <div class="card">
        <div class="row spread"><h2>Live status</h2><span class="tag" id="liveCount">…</span></div>
        <table><thead><tr><th>Member</th><th>Status</th><th>Score</th><th>Time</th><th></th></tr></thead>
        <tbody id="liveBody"><tr><td colspan="5" class="mut">Loading…</td></tr></tbody></table>
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
    <div style="margin-top:10px"><a href="#/admin" class="mut">← Dashboard</a></div>
    <div class="kicker" style="margin-top:10px">${esc(c.name)}</div>
    <h1>${typeName}</h1>
    <div class="row" style="margin-top:6px"><span class="tag ${c.status === "active" ? "" : c.status === "closed" ? "red" : "gray"}">${c.status}</span>
    <span class="mut">${c.type === "wonderlic" ? "30 questions · 6:00 · ties broken by speed" : c.type === "trex" ? "3 practice runs · 1 real run · highest score wins" : "Order drawn when all members lock in"}</span></div>
    ${block}
    <div class="card">
      <h2>Competition settings</h2>
      <label>League name</label><input type="text" id="lname" value="${esc(c.name)}" maxlength="60">
      <label>Number of members (draft slots)</label><input type="number" id="lmembers" value="${c.member_count}" min="2" max="64">
      <div class="okmsg" id="lmsg"></div>
      <button class="btn ghost" id="lsave">Save changes</button>
    </div></div>`;

  document.querySelectorAll("[data-copy]").forEach((b) => {
    const label = b.dataset.copyLabel || "Copy link";
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; setTimeout(() => (b.textContent = label), 1500); } catch {}
    };
  });
  // Tone tabs on the share-message card keep the bubble and copy payload in sync.
  const shareMsgs = c.type === "random_order" ? MSGS_DRAW : c.type === "trex" ? MSGS_TREX : MSGS_TEST;
  if ($("#shareBubble")) {
    document.querySelectorAll("[data-share-tone]").forEach((t) => {
      t.onclick = () => {
        const i = Number(t.dataset.shareTone);
        document.querySelectorAll("[data-share-tone]").forEach((o) => o.classList.toggle("sel", o === t));
        const full = shareMsgs[i] + "\n\n" + shareUrl;
        $("#shareBubble").textContent = full;
        const cb = $("#shareCopyBtn");
        if (cb) { cb.dataset.copy = full; cb.textContent = "Copy message"; }
      };
    });
  }
  $("#lsave").onclick = async () => {
    await aapi("/api/admin/competition/" + id + "/settings", {
      name: $("#lname").value, member_count: Number($("#lmembers").value),
    });
    $("#lmsg").textContent = "Saved.";
  };
  if (c.status === "draft") {
    $("#beginBtn").onclick = async () => {
      const r = await aapi("/api/admin/competition/" + id + "/activate", {});
      if (r && r.paywall) { showPaywall(r.paywall); return; }
      compView(id);
    };
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
        "<tr><td>" + esc(p.name) + (p.real_name ? '<div class="mut" style="font-size:12px">' + esc(p.real_name) + "</div>" : "") + "</td>" +
        "<td>" + (p.dnf ? '<span class="tag red">DNF</span>' : p.finished ? '<span class="tag green">Finished</span>' : p.started ? '<span class="tag">In test</span>' : '<span class="tag gray">Joined</span>') + "</td>" +
        "<td>" + (p.score ?? "&mdash;") + "</td>" +
        "<td>" + (p.duration_ms != null ? fmtDur(p.duration_ms) : "&mdash;") + "</td>" +
        "<td>" + (r.status === "active" ? '<button class="btn ghost small" data-del="' + p.id + '" data-nm="' + esc(p.name) + '" title="Remove this entry">&#10005;</button>' : "") + "</td></tr>"
      ).join("") || '<tr><td colspan="5" class="mut">No one has joined yet.</td></tr>';
      $("#liveBody").querySelectorAll("[data-del]").forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Remove "' + b.dataset.nm + '" from this competition? Their attempt is deleted too.')) return;
          const res = await aapi("/api/admin/competition/" + id + "/participants/" + b.dataset.del + "/delete", {});
          if (res.error) alert(res.error);
          poll();
        };
      });
    } catch {}
  }
  poll();
  addTimer(setInterval(poll, 3000));
}

/* ================= owner metrics ================= */
async function metricsView() {
  clearTimers();
  let d;
  try { d = await aapi("/api/admin/metrics"); } catch { return; }
  if (d.error) return adminHome();
  wrap().classList.add("wide");
  const t = d.totals;
  const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const completionRate = t.members_joined ? Math.round((t.tests_finished / t.members_joined) * 100) + "%" : "—";
  app().innerHTML = `
    <div style="text-align:left">
    <div style="margin-top:10px"><a href="#/admin" class="mut">← Dashboard</a></div>
    <div class="kicker" style="margin-top:10px">Owner only</div>
    <h1>Business Metrics</h1>
    <div class="stats">
      ${stat(t.accounts, "Accounts")}
      ${stat(t.leagues, "Leagues")}
      ${stat(t.competitions, "Competitions created")}
      ${stat(t.pending, "Pending (live)")}
      ${stat(t.completed, "Completed")}
      ${stat(t.drafts, "Not launched")}
      ${stat(t.members_joined, "Members joined")}
      ${stat(t.tests_finished, "Tests finished")}
      ${stat(completionRate, "Join → finish rate")}
      ${stat(t.avg_score, "Avg test score")}
      ${stat(t.signups_7d, "Signups, 7 days")}
      ${stat(t.tests_finished_7d, "Tests finished, 7 days")}
      ${stat(t.cta_clicks, "Viral CTA clicks")}
      ${stat(t.signups_via_cta, "Signups via CTA")}
    </div>
    <div class="card">
      <h2>Accounts</h2>
      <table><thead><tr><th>Email</th><th>Joined</th><th>Leagues</th><th>Comps</th><th>Members</th><th>Finished</th></tr></thead>
      <tbody>${d.accounts.map((a) =>
        "<tr><td>" + esc(a.email) + "</td>" +
        "<td>" + new Date(a.created_at).toLocaleDateString() + "</td>" +
        "<td>" + a.leagues + "</td><td>" + a.competitions + "</td>" +
        "<td>" + a.members_joined + "</td><td>" + a.finished + "</td></tr>"
      ).join("")}</tbody></table>
    </div></div>`;
}

/* ================= landing page ================= */
function landingView() {
  clearTimers();
  const L = landingEl();
  if (!L) return renderLogin();
  wrap().classList.remove("wide");
  wrap().classList.add("landing");
  app().innerHTML = "";
  app().hidden = true;
  L.hidden = false;
  wireLanding();
}

function wireLanding() {
  if (landingWired) return;
  landingWired = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const L = landingEl();
  const q = (s) => L.querySelector(s);

  /* --- sample test (5 original questions, 60 seconds) --- */
  const QS = [
    { q: "Notebooks sell for 35 cents each. What will 3 notebooks cost?", o: ["95 cents", "$1.05", "$1.15", "$1.20"], a: 1 },
    { q: "Which of these is least like the others?", o: ["Oak", "Maple", "Granite", "Birch"], a: 2 },
    { q: "Assume the first two statements are true. Every runner on the squad owns spikes. Dana is on the squad. So: Dana owns spikes. That is —", o: ["True", "False", "Not certain", "Impossible to say"], a: 0 },
    { q: "In 20 days a shop ships 15 orders. At that rate, how many orders in 60 days?", o: ["40", "45", "50", "55"], a: 1 },
    { q: "OAR is to ROWBOAT as PEDAL is to —", o: ["Bicycle", "Shoe", "Road", "Wheel"], a: 0 }
  ];
  let idx = 0, score = 0, left = 60, timer = null;
  const elStart = q("#tStart"), elPlay = q("#tPlay"), elRes = q("#tResult"),
        elClock = q("#testClock"), elProg = q("#tProg"), elQ = q("#qText"),
        elOpts = q("#qOpts"), elCount = q("#qCount");
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.max(0, s % 60)).padStart(2, "0");

  function paint() {
    const item = QS[idx];
    elCount.textContent = "Question " + (idx + 1) + " of " + QS.length;
    elQ.textContent = item.q;
    elOpts.innerHTML = "";
    item.o.forEach((text, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "lp-opt";
      b.innerHTML = '<span class="lp-k">' + "ABCD"[i] + "</span><span></span>";
      b.lastChild.textContent = text;
      b.addEventListener("click", () => answer(b, i, item.a));
      elOpts.appendChild(b);
    });
    elProg.style.width = (idx / QS.length * 100) + "%";
  }
  function answer(btn, picked, correct) {
    Array.prototype.forEach.call(elOpts.children, (c) => { c.disabled = true; });
    if (picked === correct) { score++; btn.classList.add("lp-right"); }
    else { btn.classList.add("lp-wrong"); elOpts.children[correct].classList.add("lp-right"); }
    setTimeout(() => { idx++; if (idx >= QS.length) finish(); else paint(); }, reduce ? 120 : 420);
  }
  function tick() {
    left--; elClock.textContent = fmt(left);
    if (left <= 15) elClock.classList.add("lp-hot");
    if (left <= 0) finish();
  }
  function finish() {
    clearInterval(timer);
    elPlay.hidden = true; elStart.hidden = true; elRes.hidden = false;
    elProg.style.width = "100%";
    q("#scoreVal").textContent = score;
    q("#timeVal").textContent = fmt(60 - left);
    elCount.textContent = "Complete";
    elClock.classList.remove("lp-hot");
    elClock.textContent = fmt(Math.max(0, left));
  }
  q("#startBtn").addEventListener("click", () => {
    elStart.hidden = true; elPlay.hidden = false;
    paint(); elClock.textContent = fmt(left);
    timer = setInterval(tick, 1000);
    addTimer(timer);
  });

  /* --- message preview: tone tabs only, no copy until a league exists --- */
  const PREVIEW = MSGS_TEST.map((m) => m + "\n\n[your league's link]");
  const msgEl = q("#msg");
  msgEl.textContent = PREVIEW[0];
  L.querySelectorAll(".lp-tone").forEach((t) => {
    t.addEventListener("click", () => {
      L.querySelectorAll(".lp-tone").forEach((o) => o.setAttribute("aria-pressed", o === t ? "true" : "false"));
      msgEl.textContent = PREVIEW[Number(t.dataset.tone)];
    });
  });

  /* --- "send it to your league" jump --- */
  L.querySelectorAll("[data-copy-jump],[data-jump]").forEach((b) => {
    b.addEventListener("click", () => {
      const target = L.querySelector(b.dataset.jump || "#send");
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.pageYOffset - 10;
      window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    });
  });

  /* --- scroll reveals --- */
  const revealAll = () => L.querySelectorAll(".lp-card, .lp-plate").forEach((k) => k.classList.add("lp-in"));
  if ("IntersectionObserver" in window && !reduce) {
    let fired = false;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        fired = true;
        Array.prototype.forEach.call(e.target.children, (k, i) => {
          setTimeout(() => k.classList.add("lp-in"), i * 110);
        });
        io.unobserve(e.target);
      });
    }, { threshold: 0.14 });
    L.querySelectorAll(".lp-js-reveal").forEach((g) => io.observe(g));
    // safety net: never leave real content stuck at opacity 0
    setTimeout(() => { if (!fired) revealAll(); }, 1400);
  } else {
    revealAll();
  }
}

/* ================= router ================= */
function route() {
  clearTimers();
  const L = landingEl();
  if (L) L.hidden = true;
  app().hidden = false;
  wrap().classList.remove("landing");
  const h = location.hash;
  let m;
  // Member links first: a group-chat link must never hit the landing page.
  if ((m = h.match(/^#\/c\/([\w-]+)/))) return memberView(m[1]);
  if ((m = h.match(/^#\/r\/([\w-]+)/))) return resultsView(m[1]);
  if (h.match(/^#\/landing/)) return landingView();
  if (h.match(/^#\/login/)) return localStorage.getItem("adm") ? adminHome() : renderLogin();
  if (h.match(/^#\/admin\/signup/)) return localStorage.getItem("adm") ? adminHome() : renderLogin("", "signup");
  if (h.match(/^#\/admin\/metrics/)) return metricsView();
  if (h.match(/^#\/admin\/league\//)) { location.hash = "#/admin"; return; }
  if ((m = h.match(/^#\/admin\/comp\/([\w-]+)/))) return compView(m[1]);
  if (h === "" || h === "#" || h === "#/") {
    if (localStorage.getItem("adm")) { location.hash = "#/admin"; return; }
    return landingView();
  }
  return adminHome();
}
window.addEventListener("hashchange", route);
route();
