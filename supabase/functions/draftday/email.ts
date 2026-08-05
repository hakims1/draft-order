// Transactional email. Sent through Resend's REST API with plain fetch — no
// SDK, no dependency. Inert until RESEND_API_KEY is set: sendEmail() returns
// {skipped:true} and callers carry on, so the app behaves identically with or
// without mail configured.

import sql from "./db.ts";
import { PRICES, attemptState, compQuestions, eventsFor, standings } from "./logic.ts";
import { logEvent } from "./gates.ts";

export const emailEnabled = () => !!Deno.env.get("RESEND_API_KEY");

const FROM = () => Deno.env.get("EMAIL_FROM") ?? "The Proving Ground <results@theprovingground.app>";

export async function sendEmail(to: string, subject: string, html: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { skipped: true as const };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("resend send failed:", res.status, body.slice(0, 300));
    return { ok: false as const, status: res.status };
  }
  return { ok: true as const };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slot = (n: number) => "1." + String(n).padStart(2, "0");

// The question this league got wrong most often — the honest teaser for the
// answer key, drawn from their own competition rather than a stock example.
async function mostMissed(comp: any) {
  const events = eventsFor(comp);
  if (!events.includes("wonderlic")) return null;
  const [questions, attempts] = await Promise.all([
    compQuestions(comp),
    sql`
      select a.state from attempts a
      join participants p on p.id = a.participant_id
      where p.competition_id = ${comp.id} and a.event_key = 'wonderlic' and a.status = 'finished'`,
  ]);
  if (!attempts.length) return null;

  let worst: { q: any; missed: number } | null = null;
  for (const q of questions as any[]) {
    let missed = 0;
    for (const a of attempts as any[]) {
      const answers = attemptState(a).answers ?? {};
      if (answers[q.id] !== q.correct_index) missed++;
    }
    if (!worst || missed > worst.missed) worst = { q, missed };
  }
  if (!worst || worst.missed === 0) return null;
  return { prompt: worst.q.prompt, missed: worst.missed, total: attempts.length };
}

// ---------- the completion email ----------

export async function buildCompletionEmail(comp: any, site: string, opts: {
  canBuyKey: boolean;
  hasKey: boolean;
}) {
  const rows = await standings(comp);
  const sample = await mostMissed(comp);
  const base = site.replace(/\/?$/, "/");
  const resultsUrl = comp.results_token ? `${base}#/r/${comp.results_token}` : base;
  const keyUrl = `${base}#/c/${comp.share_token}`;
  const league = comp.name;
  const isCombine = comp.type === "combine";

  // Plain-text order, ready to paste into the group chat.
  const plain = rows
    .map((r: any) => `${slot(r.rank)}  ${r.name}${r.dnf ? "  (DNF)" : ""}`)
    .join("\n");

  const orderRows = rows.map((r: any) => {
    const first = r.rank === 1 && !r.dnf;
    const stat = r.dnf
      ? "DNF"
      : isCombine && r.avg != null
        ? `avg ${Number(r.avg).toFixed(1)}`
        : r.score != null ? String(r.score) : "";
    return `
      <tr>
        <td style="padding:13px 14px;border-bottom:1px solid #1E2942;background:${first ? "#16203a" : "#0D1424"};
                   font-family:'SF Mono',Menlo,Consolas,monospace;font-size:17px;
                   color:${first ? "#FFB01F" : "#5A6379"};width:64px;">${slot(r.rank)}</td>
        <td style="padding:13px 14px;border-bottom:1px solid #1E2942;background:${first ? "#16203a" : "#0D1424"};
                   font-family:Helvetica,Arial,sans-serif;font-weight:${first ? 700 : 600};
                   font-size:${first ? "20px" : "17px"};color:${r.dnf ? "#5A6379" : "#EDEFF5"};">
          ${esc(r.name)}${r.real_name ? `<div style="font-size:12px;color:#8B94A9;font-weight:400;margin-top:2px;">${esc(r.real_name)}</div>` : ""}
        </td>
        <td style="padding:13px 14px;border-bottom:1px solid #1E2942;background:${first ? "#16203a" : "#0D1424"};
                   font-family:'SF Mono',Menlo,Consolas,monospace;font-size:15px;text-align:right;
                   color:${first ? "#C9A44C" : "#8B94A9"};white-space:nowrap;">${esc(stat)}</td>
      </tr>`;
  }).join("");

  const upsell = !sample ? "" : hasOrBuy();

  function hasOrBuy() {
    if (opts.hasKey) {
      return `
      <tr><td style="padding:0 24px 28px;">
        <div style="border:1px solid #8C7231;background:#0D1424;padding:20px;">
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;
                      text-transform:uppercase;color:#C9A44C;">Included with Ultimate</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#EDEFF5;margin-top:8px;">
            Your answer key is ready</div>
          <p style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#8B94A9;margin:10px 0 0;">
            ${sample!.missed} of ${sample!.total} players missed this one:
            <span style="color:#EDEFF5;">&ldquo;${esc(sample!.prompt)}&rdquo;</span>
            See every question each of them got wrong.</p>
          <a href="${keyUrl}" style="display:inline-block;margin-top:16px;background:#C9A44C;color:#0A0E1A;
             text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;
             padding:14px 26px;">Open the answer key</a>
        </div>
      </td></tr>`;
    }
    const cta = opts.canBuyKey
      ? `<a href="${keyUrl}" style="display:inline-block;margin-top:16px;background:#FFB01F;color:#0A0E1A;
           text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;
           padding:14px 26px;">Unlock the answer key &mdash; $${PRICES.answer_key}</a>`
      : `<a href="${resultsUrl}" style="display:inline-block;margin-top:16px;background:#FFB01F;color:#0A0E1A;
           text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;
           padding:14px 26px;">See the full results</a>
         <div style="font-family:Helvetica,Arial,sans-serif;font-size:12.5px;color:#5A6379;margin-top:10px;">
           The answer key unlocks for anyone in the league who took the test.</div>`;
    return `
      <tr><td style="padding:0 24px 28px;">
        <div style="border:1px solid #8C7231;background:#0D1424;padding:20px;">
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;
                      text-transform:uppercase;color:#C9A44C;">Now the fun part</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;color:#EDEFF5;margin-top:8px;">
            Find out who actually knew what</div>
          <p style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#8B94A9;margin:10px 0 14px;">
            <b style="color:#EDEFF5;">${sample!.missed} of ${sample!.total}</b> players in ${esc(league)} missed this question:</p>

          <div style="border-left:3px solid #C9A44C;background:#152039;padding:14px 16px;">
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#EDEFF5;">
              ${esc(sample!.prompt)}</div>
            <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;color:#5A6379;margin-top:12px;">
              Correct answer &nbsp;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&nbsp; locked</div>
          </div>

          <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#8B94A9;margin:14px 0 0;">
            The answer key shows every question <i>each player</i> got wrong, with the right answer and why.
            It settles the group chat argument before it starts.</p>
          ${cta}
        </div>
      </td></tr>`;
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(league)} — the order is in</title>
</head>
<body style="margin:0;padding:0;background:#0A0E1A;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Every slot is earned. Here's the final order for ${esc(league)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0E1A;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:560px;background:#0A0E1A;border:1px solid #1E2942;">

      <tr><td style="padding:26px 24px 0;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;
                    text-transform:uppercase;letter-spacing:1px;color:#EDEFF5;">
          <span style="color:#C9A44C;">The</span> Proving Ground</div>
      </td></tr>

      <tr><td style="padding:22px 24px 0;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2.5px;
                    text-transform:uppercase;color:#C9A44C;">${esc(league)}</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:34px;line-height:1.05;font-weight:700;
                    text-transform:uppercase;color:#EDEFF5;margin-top:8px;">The order is in</div>
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:15.5px;line-height:1.55;color:#8B94A9;margin:12px 0 0;">
          Everyone has finished. Here is the final draft order — screenshot it, or send the link so your
          league can watch the reveal themselves.</p>
      </td></tr>

      <tr><td style="padding:22px 24px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #1E2942;border-collapse:collapse;">${orderRows}</table>
      </td></tr>

      <tr><td style="padding:18px 24px 0;">
        <a href="${resultsUrl}" style="display:block;text-align:center;background:#FFB01F;color:#0A0E1A;
           text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:17px;
           padding:16px;">View &amp; share the results page</a>
      </td></tr>

      <tr><td style="padding:16px 24px 24px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;
                    text-transform:uppercase;color:#5A6379;margin-bottom:8px;">Copy for the group chat</div>
        <pre style="margin:0;background:#0D1424;border:1px solid #1E2942;padding:14px 16px;
                    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13.5px;line-height:1.7;
                    color:#EDEFF5;white-space:pre-wrap;">${esc(league)} — final draft order
${esc(plain)}

Earned at ${base}</pre>
      </td></tr>

      ${upsell}

      <tr><td style="padding:0 24px 26px;border-top:1px solid #1E2942;">
        <p style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#5A6379;margin:16px 0 0;">
          You're getting this because you created this competition on The Proving Ground.
          <a href="${base}" style="color:#8C7231;">theprovingground.app</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  const text = `${league} — the order is in

Everyone has finished. Final draft order:

${plain}

View and share the results: ${resultsUrl}
${sample && !opts.hasKey ? `
${sample.missed} of ${sample.total} players missed: "${sample.prompt}"
The answer key shows every question each player got wrong, with the right
answer and why${opts.canBuyKey ? ` — $${PRICES.answer_key}` : ""}: ${opts.canBuyKey ? keyUrl : resultsUrl}
` : ""}
You're getting this because you created this competition on The Proving Ground.
${base}`;

  return { subject: `The order is in — ${league}`, html, text };
}

// Claim-and-send. The conditional UPDATE is the lock: whichever request first
// observes the competition as complete wins the claim, everyone else no-ops.
export async function notifyCompetitionComplete(comp: any, site: string) {
  if (!comp?.id || comp.completed_notified_at) return { sent: false as const };

  const claimed = await sql`
    update competitions set completed_notified_at = now()
    where id = ${comp.id} and completed_notified_at is null
    returning id`;
  if (!claimed.length) return { sent: false as const }; // someone else got there first
  comp.completed_notified_at = new Date().toISOString();

  try {
    const [admin] = await sql`select id, email from admins where id = ${comp.admin_id}`;
    if (!admin?.email) return { sent: false as const };

    // Tailor the upsell. Participants carry no email, so there is no reliable
    // link from a commissioner to their own seat — the email deliberately does
    // not guess. It sends them to their member view, where the existing
    // eligibility rules resolve buy / unlock / already-owned correctly.
    const [owned] = await sql`
      select 1 from entitlements
      where revoked_at is null
        and ((sku = 'ultimate' and admin_id = ${comp.admin_id})
          or (sku = 'answer_key' and competition_id = ${comp.id}
              and buyer_admin_id = ${comp.admin_id}))`;
    const hasKey = !!owned;
    const canBuyKey = !hasKey;

    const mail = await buildCompletionEmail(comp, site, { canBuyKey, hasKey });
    const r = await sendEmail(admin.email, mail.subject, mail.html, mail.text);
    await logEvent("competition_completed_email", {
      adminId: comp.admin_id,
      competitionId: comp.id,
      props: { skipped: !!(r as any).skipped, ok: !!(r as any).ok, can_buy_key: canBuyKey, has_key: hasKey },
    });
    return { sent: !!(r as any).ok };
  } catch (e) {
    console.error("completion email failed:", e);
    return { sent: false as const };
  }
}
