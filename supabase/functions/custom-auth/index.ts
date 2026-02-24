import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Internal-Secret",
};

function maskHeaders(headers: Headers) {
  const obj: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === "x-internal-secret" || k.toLowerCase() === "authorization") {
      obj[k] = "***";
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

function safeBodyForLog(body: any) {
  const clone = { ...(body ?? {}) };
  if (clone.password) clone.password = "***";
  if (clone.newPassword) clone.newPassword = "***";
  if (clone.confirmPassword) clone.confirmPassword = "***";
  if (clone.newConfirmPassword) clone.newConfirmPassword = "***";
  return clone;
}

function normalizeRuPhone(input: string): string {
  let d = input.replace(/[^\d]/g, "");
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length !== 11 || !d.startsWith("7")) {
    throw new Error("Некорректный номер телефона. Ожидается 7XXXXXXXXXX или +7XXXXXXXXXX");
  }
  return d;
}

async function sha256Hex(input: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    let data: any = null;
    try {
      data = await resp.json();
    } catch {
      // ignore
    }
    return { resp, data };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  // Лог (без секрета)
  console.log("Incoming request:", {
    method: req.method,
    url: req.url,
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

  // ВАЖНО: функция доступна только через Next.js proxy (X-Internal-Secret)
  const expectedSecret = Deno.env.get("CUSTOM_AUTH_SECRET");
  const gotSecret = req.headers.get("X-Internal-Secret");
  if (!expectedSecret) {
    return new Response(JSON.stringify({ success: false, error: "CUSTOM_AUTH_SECRET не задан" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (!gotSecret || gotSecret !== expectedSecret) {
    return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const body = await req.json();
    console.log("Received body:", safeBodyForLog(body));

    const { phone, mode, password, newPassword, verificationMethod, otp } = body ?? {};
    if (!phone) throw new Error("Отсутствует номер телефона в запросе");

    const cleanPhone = normalizeRuPhone(String(phone));
    const userEmail = `user_${cleanPhone}@example.com`;

    const NEW_TEL_API_KEY = Deno.env.get("NEW_TEL_API_KEY");
    const NEW_TEL_SIGN_KEY = Deno.env.get("NEW_TEL_SIGN_KEY");
    if (!NEW_TEL_API_KEY || !NEW_TEL_SIGN_KEY) throw new Error("Ключи New-Tel не установлены");

    const NEWTEL_CALLBACK_URL = Deno.env.get("NEWTEL_CALLBACK_URL");
    if (!NEWTEL_CALLBACK_URL) throw new Error("NEWTEL_CALLBACK_URL не установлен");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Переменные окружения Supabase не установлены");

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    async function getUserByPhone(phoneNorm: string) {
      const { data, error } = await supabaseAdmin.rpc("find_user_by_phone", { p_phone: phoneNorm });
      if (error) throw new Error("Ошибка поиска пользователя: " + error.message);
      return (data && Array.isArray(data) && data[0]) ? data[0] : null;
    }

    async function upsertOrReplace(table: "temp_verifications" | "temp_otps", row: any) {
      // 1) Пытаемся upsert (нужен unique/PK по phone)
      const up = await supabaseAdmin.from(table).upsert(row, { onConflict: "phone" });
      if (!up.error) return;

      // 2) Fallback: delete + insert (чтобы работало даже без unique constraint)
      console.log(`Upsert failed for ${table}, fallback to delete+insert:`, up.error.message);
      const del = await supabaseAdmin.from(table).delete().eq("phone", row.phone);
      if (del.error) throw new Error(`Не удалось обновить ${table}: ` + del.error.message);
      const ins = await supabaseAdmin.from(table).insert(row);
      if (ins.error) throw new Error(`Не удалось вставить ${table}: ` + ins.error.message);
    }

    function makeBearer(methodName: string, paramsJson: string, time: string, apiKey: string, signKey: string) {
      return sha256Hex(`${methodName}\n${time}\n${apiKey}\n${paramsJson}\n${signKey}`)
        .then((sig) => `${apiKey}${time}${sig}`);
    }

    // -------------------------
    // LOGIN
    // -------------------------
    if (mode === "login") {
      if (!password) throw new Error("Отсутствует пароль в запросе");

      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email: userEmail,
        password,
      });
      if (error) throw new Error("Неверные данные для входа");

      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("user_id")
        .eq("user_id", data.user.id)
        .maybeSingle();

      return new Response(JSON.stringify({
        success: true,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        redirect: profile ? "/trips" : "/profile/setup",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // -------------------------
    // VERIFY / RECOVER (start flow)
    // -------------------------
    if (mode === "verify" || mode === "recover") {
      if (mode === "verify" && !password) {
        throw new Error("Для регистрации нужен пароль");
      }

      const existing = await getUserByPhone(cleanPhone);

      if (mode === "verify") {
        if (existing) {
          if (existing.email_confirmed_at) {
            throw new Error("Пользователь с таким номером уже зарегистрирован");
          }
          const upd = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
            email: userEmail,
            phone: cleanPhone,
            password,
            email_confirmed_at: null,
          });
          if (upd.error) throw new Error("Не удалось обновить данные пользователя: " + upd.error.message);
        } else {
          const crt = await supabaseAdmin.auth.admin.createUser({
            phone: cleanPhone,
            email: userEmail,
            password,
            email_confirmed_at: null,
          });
          if (crt.error) throw new Error("Не удалось создать пользователя: " + crt.error.message);
        }
      }

      if (mode === "recover") {
        if (!existing) throw new Error("Пользователь с таким номером не найден");
        if (!existing.email_confirmed_at) {
          throw new Error("Ваш аккаунт не закончил верификацию, пожалуйста пройдите регистрацию повторно");
        }
      }

      // --- OTP (password call) ---
      if (verificationMethod === "otp") {
        const params = JSON.stringify({ dstNumber: cleanPhone });
        const methodName = "call-password/start-password-call";
        const time = Math.floor(Date.now() / 1000).toString();
        const bearerToken = await makeBearer(methodName, params, time, NEW_TEL_API_KEY, NEW_TEL_SIGN_KEY);

        const { resp: newTelResp, data: newTelData } = await fetchJsonWithTimeout(
          "https://api.new-tel.net/call-password/start-password-call",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${bearerToken}`,
              "Accept": "application/json",
            },
            body: params,
          },
          7000,
        );

        if (!newTelResp.ok) {
          if (newTelResp.status === 429) throw new Error("Слишком много попыток, подождите несколько минут и попробуйте снова");
          throw new Error(newTelData?.message || "Не удалось отправить звонок, попробуйте позже");
        }

        if (newTelData?.status === "error") {
          throw new Error(newTelData?.message || "Не удалось отправить звонок, попробуйте позже");
        }

        if (newTelData?.data?.result === "error") {
          throw new Error(newTelData?.data?.message || "Не удалось отправить звонок, попробуйте позже");
        }

        const generatedOtp = newTelData?.data?.callDetails?.pin;
        const callId = newTelData?.data?.callDetails?.callId;

        if (!generatedOtp || String(generatedOtp).length !== 4) {
          throw new Error("Не удалось получить код верификации, попробуйте снова");
        }
        if (!callId) throw new Error("Не удалось подтвердить отправку звонка, попробуйте снова");

        await upsertOrReplace("temp_otps", {
          phone: cleanPhone,
          otp: String(generatedOtp),
          call_id: String(callId),
          expires_at: new Date(Date.now() + 15 * 60 * 1000),
        });

        return new Response(JSON.stringify({ success: true, method: "otp", callId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // --- CALL (inbound call waiting) ---
      const params = JSON.stringify({
        clientNumber: cleanPhone,
        callbackLink: NEWTEL_CALLBACK_URL,
        timeout: 60,
      });

      const methodName = "call-verification/start-inbound-call-waiting";
      const time = Math.floor(Date.now() / 1000).toString();
      const bearerToken = await makeBearer(methodName, params, time, NEW_TEL_API_KEY, NEW_TEL_SIGN_KEY);

      const { resp: newTelResp, data: newTelData } = await fetchJsonWithTimeout(
        "https://api.new-tel.net/call-verification/start-inbound-call-waiting",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${bearerToken}`,
            "Accept": "application/json",
          },
          body: params,
        },
        7000,
      );

      if (!newTelResp.ok) {
        if (newTelResp.status === 429) throw new Error("Слишком много попыток, подождите несколько минут и попробуйте снова");
        throw new Error(newTelData?.message || "Не удалось начать верификацию, попробуйте позже");
      }

      if (newTelData?.status === "error") {
        throw new Error(newTelData?.message || "Не удалось начать верификацию, попробуйте позже");
      }

      if (newTelData?.data?.result === "error") {
        throw new Error(newTelData?.data?.message || "Не удалось начать верификацию, попробуйте позже");
      }

      const callDetails = newTelData?.data?.callDetails;
      const callNumber = callDetails?.confirmationNumber;
      const qrCodeUrl = callDetails?.qrCodeUri;
      const callId = callDetails?.callId;

      if (!callNumber || !qrCodeUrl || !callId) {
        throw new Error("Не удалось получить данные для верификации, попробуйте снова");
      }

      await upsertOrReplace("temp_verifications", {
        phone: cleanPhone,
        call_id: String(callId),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        verified: false,
        is_registration: mode === "verify",
      });

      return new Response(JSON.stringify({ success: true, callNumber, qrCodeUrl, method: "call" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // -------------------------
    // VERIFY OTP (register)
    // -------------------------
    if (mode === "verify_otp") {
      if (!otp) throw new Error("Отсутствует otp");
      if (!password) throw new Error("Отсутствует пароль");

      const { data: verifyData, error: verifyError } = await supabaseAdmin.rpc("verify_phone_otp", {
        phone_number: cleanPhone,
        input_otp: String(otp),
      });
      if (verifyError) throw new Error("Ошибка при проверке кода верификации");
      if (!verifyData?.success) {
        throw new Error(
          verifyData?.error && String(verifyData.error).includes("Invalid or expired OTP")
            ? "Неверный или истекший код верификации"
            : "Неверный код верификации",
        );
      }

      const user = await getUserByPhone(cleanPhone);
      if (!user) throw new Error("Пользователь не найден");

      const upd = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        email_confirmed_at: new Date().toISOString(),
      });
      if (upd.error) throw new Error("Не удалось завершить верификацию: " + upd.error.message);

      const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
        email: userEmail,
        password,
      });
      if (sessionError || !sessionData?.session) throw new Error("Ошибка входа");

      return new Response(JSON.stringify({
        success: true,
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        redirect: "/profile/setup",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // -------------------------
    // VERIFY OTP (recover)
    // -------------------------
    if (mode === "verify_otp_recover") {
      if (!otp) throw new Error("Отсутствует otp");

      const { data: verifyData, error: verifyError } = await supabaseAdmin.rpc("verify_phone_otp", {
        phone_number: cleanPhone,
        input_otp: String(otp),
      });
      if (verifyError) throw new Error("Ошибка при проверке кода верификации");
      if (!verifyData?.success) {
        throw new Error(
          verifyData?.error && String(verifyData.error).includes("Invalid or expired OTP")
            ? "Неверный или истекший код верификации"
            : "Неверный код верификации",
        );
      }

      const up = await supabaseAdmin.from("temp_verifications").upsert(
        { phone: cleanPhone, verified: true, expires_at: new Date(Date.now() + 15 * 60 * 1000) },
        { onConflict: "phone" },
      );
      if (up.error) throw new Error("Не удалось завершить верификацию");

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // -------------------------
    // RECOVER COMPLETE
    // -------------------------
    if (mode === "recover_complete") {
      if (!newPassword) throw new Error("Новый пароль обязателен");

      const { data: verification, error: verErr } = await supabaseAdmin
        .from("temp_verifications")
        .select("verified, expires_at")
        .eq("phone", cleanPhone)
        .maybeSingle();

      if (verErr) throw new Error("Ошибка проверки верификации");
      if (!verification?.verified) throw new Error("Верификация не завершена");

      const user = await getUserByPhone(cleanPhone);
      if (!user) throw new Error("Пользователь не найден");

      const upd = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: String(newPassword) });
      if (upd.error) throw new Error("Не удалось обновить пароль: " + upd.error.message);

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    throw new Error("Неверный режим");
  } catch (error: any) {
    console.error("Ошибка в custom-auth:", error?.message);
    return new Response(JSON.stringify({ success: false, error: error?.message || "Ошибка" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
