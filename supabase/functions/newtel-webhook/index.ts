import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function maskHeaders(headers: Headers) {
  const obj: Record<string, string> = {};
  for (const [k, v] of headers.entries()) obj[k] = v;
  return obj;
}

function normalizeRuPhone(input: string): string {
  let d = String(input || "").replace(/[^\d]/g, "");
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  // допускаем 11 цифр (обычно 7XXXXXXXXXX)
  return d;
}

async function readBody(req: Request): Promise<any> {
  // 1) JSON
  try {
    return await req.json();
  } catch {
    // 2) text
    const txt = await req.text().catch(() => "");
    if (!txt) return {};
    // 2a) JSON в тексте
    try {
      return JSON.parse(txt);
    } catch {
      // 2b) form-urlencoded
      const params = new URLSearchParams(txt);
      const obj: Record<string, string> = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      return obj;
    }
  }
}

Deno.serve(async (req) => {
  const forwardedFor = req.headers.get("X-Forwarded-For");
  const ip = forwardedFor ? forwardedFor.split(",")[0].trim() : (req.headers.get("CF-Connecting-IP") ?? "unknown");

  console.log("[Info] Webhook request:", {
    method: req.method,
    url: req.url,
    ip,
    headers: maskHeaders(req.headers),
  });

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const body = await readBody(req);
    console.log("[Info] Webhook body:", body);

    const rawCallId =
      body.callId ?? body.call_id ?? body.CallId ?? body.CallID ?? body.callID ?? body?.data?.callId ?? body?.data?.call_id;

    const rawPhone =
      body.clientNumber ??
      body.client_number ??
      body.phone ??
      body.phone_number ??
      body.msisdn ??
      body?.data?.clientNumber ??
      body?.data?.client_number;

    const callId = rawCallId ? String(rawCallId) : "";
    const phone = rawPhone ? normalizeRuPhone(String(rawPhone)) : "";

    if (!callId && !phone) {
      return new Response(JSON.stringify({ success: false, error: "Missing callId and phone" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Supabase env missing");

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // 1) Найти запись
    let row: any = null;

    if (callId && phone) {
      const { data, error } = await supabaseAdmin
        .from("temp_verifications")
        .select("phone, call_id, verified, expires_at")
        .eq("call_id", callId)
        .eq("phone", phone)
        .maybeSingle();
      if (error) console.log("[Warn] lookup(call_id+phone) error:", error.message);
      row = data ?? null;
    }

    if (!row && phone) {
      // fallback: по телефону (берём свежую)
      const { data, error } = await supabaseAdmin
        .from("temp_verifications")
        .select("phone, call_id, verified, expires_at")
        .eq("phone", phone)
        .order("expires_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) console.log("[Warn] lookup(phone) error:", error.message);
      row = data ?? null;
    }

    if (!row) {
      console.log("[Warn] Verification row not found", { callId, phone });
      return new Response(JSON.stringify({ success: false, error: "Verification not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (row.verified) {
      console.log("[Info] Already verified", { phone: row.phone, call_id: row.call_id });
      return new Response(JSON.stringify({ success: true, already: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 2) Обновить
    const { error: updErr } = await supabaseAdmin
      .from("temp_verifications")
      .update({ verified: true })
      .eq("phone", row.phone)
      .eq("call_id", row.call_id);

    if (updErr) {
      console.log("[Error] Update failed:", updErr.message);
      throw new Error("Failed to update verification: " + updErr.message);
    }

    console.log("[Info] Verification updated", { phone: row.phone, call_id: row.call_id });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: any) {
    console.log("[Error] Webhook exception:", e?.message);
    return new Response(JSON.stringify({ success: false, error: e?.message || "error" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
