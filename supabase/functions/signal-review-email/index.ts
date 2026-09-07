import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const APP_URL = (Deno.env.get("VITE_APP_URL") || "https://app.tscopier.ai").replace(
  /\/$/,
  "",
);
const RESEND_FROM =
  Deno.env.get("SIGNAL_REVIEW_EMAIL_FROM") ||
  Deno.env.get("RESEND_CAMPAIGN_FROM") ||
  "TScopier <noreply@tscopier.ai>";

/** Must match AI_REVIEW_MAX_AGE_MS in worker/src/retrySignal.ts. */
const REVIEW_WINDOW_MS = 2 * 60_000;
const REVIEW_SKIP_REASON = "ai classified as uncertain; human review required";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function levelRows(parsed: Record<string, unknown>): string {
  const action = String(parsed.action ?? "").trim()
  const symbol = String(parsed.symbol ?? "").trim()
  const entry = parsed.entry_price
  const zoneLow = parsed.entry_zone_low
  const zoneHigh = parsed.entry_zone_high
  const entryText = zoneLow != null && zoneHigh != null
    ? `${zoneLow} – ${zoneHigh}`
    : entry != null
      ? String(entry)
      : ""
  const sl = parsed.sl != null ? String(parsed.sl) : ""
  const tp = Array.isArray(parsed.tp) && parsed.tp.length > 0
    ? parsed.tp.join(", ")
    : ""

  const rows: Array<[string, string]> = []
  if (symbol) rows.push(["Symbol", symbol])
  if (action) rows.push(["Action", action])
  if (entryText) rows.push(["Entry", entryText])
  if (sl) rows.push(["Stop loss", sl])
  if (tp) rows.push(["Take profit", tp])
  if (rows.length === 0) return ""

  const body = rows
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:8px 0;font-size:14px;color:#737373;border-bottom:1px solid #f0f0f0;">${esc(label)}</td>
          <td style="padding:8px 0;font-size:14px;font-weight:600;color:#171717;text-align:right;border-bottom:1px solid #f0f0f0;">${esc(value)}</td>
        </tr>`,
    )
    .join("")

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px 0;border-collapse:collapse;">${body}</table>`
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: corsHeaders },
    )
  }

  try {
    const { signal_id } = await req.json()
    if (!signal_id || typeof signal_id !== "string") {
      return Response.json(
        { error: "signal_id is required" },
        { status: 400, headers: corsHeaders },
      )
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: signal } = await supabase
      .from("signals")
      .select(
        "id,user_id,channel_id,raw_message,parsed_data,status,skip_reason,created_at",
      )
      .eq("id", signal_id)
      .maybeSingle()

    if (!signal) {
      return Response.json(
        { ok: true, skipped: true, reason: "signal_not_found" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    if (
      String(signal.status).toLowerCase() !== "skipped" ||
      String(signal.skip_reason ?? "").trim().toLowerCase() !== REVIEW_SKIP_REASON
    ) {
      return Response.json(
        { ok: true, skipped: true, reason: "not_a_review_signal" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const createdMs = Date.parse(String(signal.created_at ?? ""))
    if (!Number.isFinite(createdMs) || Date.now() - createdMs > REVIEW_WINDOW_MS) {
      return Response.json(
        { ok: true, skipped: true, reason: "approval_window_expired" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const { data: authUser } = await supabase.auth.admin.getUserById(signal.user_id)
    const email = authUser?.user?.email
    if (!email) {
      return Response.json(
        { ok: true, skipped: true, reason: "no_email_on_user" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("notification_email_enabled, display_name, first_name")
      .eq("user_id", signal.user_id)
      .maybeSingle()

    if (profile && profile.notification_email_enabled === false) {
      return Response.json(
        { ok: true, skipped: true, reason: "email_notifications_disabled" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    let channelLabel: string | null = null
    if (signal.channel_id) {
      const { data: channel } = await supabase
        .from("telegram_channels")
        .select("display_name, channel_username")
        .eq("id", signal.channel_id)
        .maybeSingle()
      channelLabel = channel?.display_name || channel?.channel_username || null
    }

    const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>
    const levelsHtml = levelRows(parsed)
    const rawMessage = String(signal.raw_message ?? "").trim()

    const channelLine = channelLabel
      ? `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#404040;">Channel: <strong>${esc(channelLabel)}</strong></p>`
      : ""

    const messageBlock = rawMessage
      ? `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#737373;background-color:#fafafa;border:1px solid #f0f0f0;border-radius:8px;padding:12px 16px;">${esc(rawMessage)}</p>`
      : ""

    const reviewUrl = `${APP_URL}/account-trades?review=${signal_id}`
    const greetName = profile?.first_name || profile?.display_name || "there"

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signal review required</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background-color:#ffffff;">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.5;color:#171717;">Hi ${esc(greetName)},</p>
    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.5;color:#171717;">A signal needs your review before it can be sent to your broker.</p>
    ${channelLine}
    ${levelsHtml}
    ${messageBlock}
    <p style="margin:0 0 24px 0;font-size:14px;line-height:1.5;color:#404040;">Your approval window is <strong>2 minutes</strong> from when the signal was received. After that, the signal is skipped automatically.</p>
    <p style="margin:0 0 24px 0;"><a href="${esc(reviewUrl)}" style="font-size:14px;font-weight:600;color:#0d9488;text-decoration:none;">Review signal &rarr;</a></p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#a3a3a3;">You can turn off these emails in Settings &rarr; Notifications.</p>
  </div>
</body>
</html>`

    const unsubscribeUrl = `${APP_URL}/account-settings/notifications`

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: "TScopier: a signal is waiting for your approval",
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "X-Entity-Id": signal_id,
        },
        categories: ["transactional"],
      }),
    })

    const resData = await res.json()

    if (!res.ok) {
      return Response.json(
        {
          error: "Resend API error",
          status: res.status,
          details: resData,
        },
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    await supabase.from("email_campaign_log").insert({
      user_id: signal.user_id,
      campaign_type: "signal_review_required",
      email_address: email,
      metadata: {
        signal_id: signal_id,
        channel_label: channelLabel,
        triggered_by: "worker_escalation",
        resend_id: resData.id,
      },
    })

    return Response.json(
      { ok: true, skipped: false, resend_id: resData.id },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})
