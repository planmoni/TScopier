import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveEmailLogoUrl } from "../_shared/brandEmailAssets.ts";
import { buildAuthEmailHtml } from "../_shared/authEmailLayout.ts";

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
const LOGO_URL = resolveEmailLogoUrl({
  supabaseUrl: SUPABASE_URL,
  appUrl: APP_URL,
  variant: "dark",
  explicitUrl: Deno.env.get("EMAIL_LOGO_URL"),
});
const RESEND_FROM =
  Deno.env.get("RESEND_CAMPAIGN_FROM") || "TScopier <noreply@tscopier.ai>";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeManagePath(raw: unknown): string {
  const path = String(raw ?? "").trim();
  if (path.startsWith("/manage-signals")) return path;
  return "/manage-signals";
}

function changedSideLabel(raw: unknown): string {
  const sides = Array.isArray(raw)
    ? raw.map((v) => String(v).toLowerCase()).filter((v) => v === "sl" || v === "tp")
    : [];
  if (sides.includes("sl") && sides.includes("tp")) return "SL/TP";
  if (sides.includes("sl")) return "SL";
  if (sides.includes("tp")) return "TP";
  return "SL/TP";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: corsHeaders },
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!SERVICE_ROLE_KEY || !timingSafeEqual(token, SERVICE_ROLE_KEY)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: corsHeaders },
    );
  }

  try {
    const body = await req.json();
    const userId = String(body.user_id ?? "").trim();
    const signalId = String(body.signal_id ?? "").trim();
    const brokerAccountId = String(body.broker_account_id ?? "").trim();
    const symbol = String(body.symbol ?? "").trim();
    const managePath = safeManagePath(body.manage_signal_path);
    const manageUrl = `${APP_URL}${managePath}`;
    const sideLabel = changedSideLabel(body.changed_sides);

    if (!userId || !signalId || !brokerAccountId) {
      return Response.json(
        { error: "user_id, signal_id, and broker_account_id are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email) {
      return Response.json(
        { ok: true, skipped: true, reason: "no_email_on_user" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("notification_email_enabled, display_name, first_name")
      .eq("user_id", userId)
      .maybeSingle();

    if (profile && profile.notification_email_enabled === false) {
      return Response.json(
        { ok: true, skipped: true, reason: "email_notifications_disabled" },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: broker } = await supabase
      .from("broker_accounts")
      .select("label, broker_name")
      .eq("id", brokerAccountId)
      .eq("user_id", userId)
      .maybeSingle();

    const brokerLabel = String(broker?.label || broker?.broker_name || "").trim();
    const details: Array<[string, string]> = [];
    if (symbol) details.push(["Symbol", symbol]);
    if (brokerLabel) details.push(["Account", brokerLabel]);
    details.push(["Change", `${sideLabel} restored by TScopier`]);

    const detailRows = details.map(([label, value]) =>
      `<tr>
        <td style="padding:8px 0;font-size:14px;color:#737373;border-bottom:1px solid #f0f0f0;">${esc(label)}</td>
        <td style="padding:8px 0;font-size:14px;font-weight:600;color:#171717;text-align:right;border-bottom:1px solid #f0f0f0;">${esc(value)}</td>
      </tr>`,
    ).join("");

    const detailsHtml = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px 0;border-collapse:collapse;">${detailRows}</table>`;

    const html = buildAuthEmailHtml({
      title: "Manual trade changes were reverted",
      greeting: `Hi ${profile?.first_name || profile?.display_name || "there"},`,
      bodyHtml: `
        <p style="margin:0 0 16px 0;">TScopier detected a manual SL/TP modification on one of your copied trades.</p>
        <p style="margin:0 0 16px 0;">Because copied trades are managed by TScopier, broker-side manual changes are automatically reconciled back to the active signal settings.</p>
        ${detailsHtml}
        <p style="margin:0;">To safely update SL or TP, use Manage Signal in TScopier.</p>
      `,
      buttonLabel: "Manage Signal",
      buttonUrl: manageUrl,
      footerNote: "You can turn off these emails in Settings - Notifications.",
      logoUrl: LOGO_URL,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: "Manual trade changes were reverted by TScopier",
        html,
      }),
    });

    const resData = await res.json();

    if (!res.ok) {
      return Response.json(
        { error: "Resend API error", status: res.status, details: resData },
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase.from("email_campaign_log").insert({
      user_id: userId,
      campaign_type: "manual_broker_override_reverted",
      email_address: email,
      metadata: {
        signal_id: signalId,
        broker_account_id: brokerAccountId,
        symbol: symbol || null,
        manage_signal_path: managePath,
        triggered_by: "basket_sl_tp_reconcile_monitor",
        resend_id: resData.id,
      },
    });

    return Response.json(
      { ok: true, skipped: false, resend_id: resData.id },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});