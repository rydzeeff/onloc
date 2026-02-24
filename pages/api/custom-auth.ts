import type { NextApiRequest, NextApiResponse } from "next";

const phoneCooldown = new Map<string, number>(); // phone -> lastMs
const ipWindow = new Map<string, { count: number; resetMs: number }>(); // ip -> window

function getClientIp(req: NextApiRequest) {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const ipFromXff = raw?.split(",")[0]?.trim();
  return ipFromXff || req.socket.remoteAddress || "unknown";
}

function normalizePhoneLoose(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let d = input.replace(/[^\d]/g, "");
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length !== 11 || !d.startsWith("7")) return null;
  return d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const secret = process.env.CUSTOM_AUTH_SECRET;
  const functionsUrl = process.env.SUPABASE_FUNCTIONS_URL;
  if (!secret) return res.status(500).json({ success: false, error: "CUSTOM_AUTH_SECRET is not set" });

  const ip = getClientIp(req);
  const body = req.body ?? {};

  // Минимальный server-side rate limit на старт верификации
  const mode = body?.mode;
  if (mode === "verify" || mode === "recover") {
    const phone = normalizePhoneLoose(body?.phone);
    if (!phone) return res.status(400).json({ success: false, error: "Некорректный телефон" });

    const now = Date.now();

    const last = phoneCooldown.get(phone) ?? 0;
    if (now - last < 20_000) {
      return res.status(429).json({ success: false, error: "Слишком часто. Подождите 20 секунд." });
    }
    phoneCooldown.set(phone, now);

    const w = ipWindow.get(ip);
    if (!w || now > w.resetMs) {
      ipWindow.set(ip, { count: 1, resetMs: now + 60_000 });
    } else {
      w.count += 1;
      if (w.count > 30) {
        return res.status(429).json({ success: false, error: "Слишком много запросов. Подождите минуту." });
      }
    }
  }

  try {
    const upstream = await fetch(`${functionsUrl}/custom-auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": secret,
        "X-Forwarded-For": ip,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";
    res.status(upstream.status).setHeader("Content-Type", contentType);
    return res.send(text);
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || "Upstream error" });
  }
}
