// /pages/api/vkcloud/selftest.js
import dns from 'node:dns/promises';
import { getVkAccessToken } from '../../../lib/vkcloud/oauth.js';

export const config = { api: { bodyParser: false } };

const DEBUG = process.env.VKCOM_DEBUG === '1';
const TIMEOUT_MS = Number(process.env.VKCOM_HTTP_TIMEOUT_MS || 7000);

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return {
    fetch: (url, opts = {}) => fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(t)),
    signal: controller.signal,
  };
}

function safe(err) {
  const c = err?.cause || {};
  return { name: err?.name, message: err?.message, code: c.code, syscall: c.syscall, hostname: c.hostname, address: c.address, port: c.port };
}

export default async function handler(req, res) {
  try {
    const tokenUrl =
      process.env.VKCOM_TOKEN_URL ||
      'https://iam.api.cloud.vk.com/auth/realms/vkcloud/protocol/openid-connect/token';
    const visionBase = process.env.VKCOM_VISION_BASE || 'https://vision.api.cloud.vk.com';
    const nsfwPath  = process.env.VKCOM_VISION_NSFW_PATH || '/vision/v1/nsfw-recognition';

    const iamHost    = new URL(tokenUrl).hostname;
    const visionHost = new URL(visionBase).hostname;

    const out = { env: {}, dns: {}, iam: {}, token: {}, vision: {} };

    // ENV presence
    out.env.VKCOM_CLIENT_ID     = !!process.env.VKCOM_CLIENT_ID;
    out.env.VKCOM_CLIENT_SECRET = !!process.env.VKCOM_CLIENT_SECRET;
    out.env.VKCOM_SCOPE         = !!process.env.VKCOM_SCOPE;
    out.env.VKCOM_TOKEN_URL     = tokenUrl;
    out.env.VKCOM_VISION_BASE   = visionBase;
    out.env.VKCOM_VISION_PATH   = nsfwPath;

    // DNS
    try { out.dns.iam = await dns.resolve4(iamHost); } catch (e) { out.dns.iam = { error: safe(e) }; }
    try { out.dns.vision = await dns.resolve4(visionHost); } catch (e) { out.dns.vision = { error: safe(e) }; }

    // IAM reachability (openid config)
    try {
      const { fetch } = withTimeout(null, TIMEOUT_MS);
      const confUrl = `https://${iamHost}/auth/realms/vkcloud/.well-known/openid-configuration`;
      const r = await fetch(confUrl, { method: 'GET', headers: { 'User-Agent': 'onloc/1.0' } });
      out.iam.status = r.status;
    } catch (e) {
      out.iam.error = safe(e);
    }

    // Token
    try {
      const t0 = Date.now();
      const token = await getVkAccessToken();
      out.token.ok = !!token;
      out.token.ms = Date.now() - t0;
      if (DEBUG && token) out.token.sample = `ok:${token.slice(0, 12)}…(${token.length})`; // редактировано
    } catch (e) {
      out.token.error = safe(e);
    }

    // Vision ping (POST по URL картинке)
    try {
      const token = await getVkAccessToken();
      const testUrl = 'https://httpbin.org/image/jpeg';
      const endpoint = visionBase.replace(/\/$/, '') + nsfwPath;

      const { fetch } = withTimeout(null, TIMEOUT_MS);
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : undefined,
          'Content-Type': 'application/json',
          'User-Agent': 'onloc/1.0',
        },
        body: JSON.stringify({ image_url: testUrl }),
      });

      const bodyText = await r.text().catch(() => '');
      out.vision.status = r.status;
      out.vision.bodyPreview = bodyText.slice(0, 400);
    } catch (e) {
      out.vision.error = safe(e);
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'selftest failed' });
  }
}
