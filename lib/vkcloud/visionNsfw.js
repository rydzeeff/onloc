// /lib/vkcloud/visionNsfw.js
import { getVkAccessToken } from './oauth.js';

const DEBUG  = process.env.VKCOM_DEBUG === '1';
const STRICT = process.env.VKCOM_NSFW_STRICT === '1';
const TIMEOUT_MS = Number(process.env.VKCOM_HTTP_TIMEOUT_MS || 7000);
const OAUTH_PROVIDER = 'mcs';

function getEndpoint(oauthToken) {
  const base = process.env.VKCOM_VISION_BASE || 'https://smarty.mail.ru';
  const path = process.env.VKCOM_VISION_NSFW_PATH || '/api/v1/adult/detect';
  const url = new URL(base.replace(/\/$/, '') + path);
  url.searchParams.set('oauth_token', oauthToken);
  url.searchParams.set('oauth_provider', OAUTH_PROVIDER);
  return url.toString();
}

function skip(reason, raw) {
  if (DEBUG) console.warn('[VKCLOUD][vision] SKIP:', reason, raw ? '(raw present)' : '');
  return { allowed: true, raw: raw || null, score: null, reason, skipped: true };
}

async function postWithTimeout(url, opts) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function parseSafeToNsfw(json) {
  const apiStatus = json?.status;
  const obj = json?.body?.objects?.[0];
  const fileStatus = obj?.status;
  const safe = typeof obj?.safe === 'number' ? obj.safe : null;

  if (apiStatus !== 200) return { error: `api_status_${apiStatus}`, safe, fileStatus };
  if (fileStatus !== 0)   return { error: `file_status_${fileStatus}`, safe, fileStatus };
  if (safe === null)      return { error: 'no_safe', safe: null, fileStatus };

  return { nsfwScore: 1 - safe, safe, fileStatus: 0 };
}

function mimeFromFilename(name) {
  if (!name) return null;
  const ext = String(name).split('.').pop().toLowerCase();
  return ({
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    tiff: 'image/tiff',
  })[ext] || null;
}

async function requestWithRetry(makeRequest) {
  const maxTries = 2; // один повтор
  let lastErr = null;

  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await makeRequest();
      if (!res.ok && (res.status === 429 || res.status >= 500)) {
        lastErr = new Error(`http_${res.status}`);
        if (i < maxTries - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
        else throw lastErr;
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
      // сетевые/таймауты пробуем ещё раз
      if (i < maxTries - 1) {
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      } else {
        throw lastErr;
      }
    }
  }
  throw lastErr;
}

export async function checkNsfwBuffer(buffer, filename, contentType) {
  const token = await getVkAccessToken();
  if (!token) {
    if (STRICT) throw new Error('no_token');
    return skip('skip_no_token');
  }

  const endpoint = getEndpoint(token);

  const fieldName = 'file';
  const type = contentType || mimeFromFilename(filename) || 'application/octet-stream';
  const blob = new Blob([buffer], { type });
  const form = new FormData();
  form.append(fieldName, blob, filename || 'image');
  form.append('meta', JSON.stringify({ images: [{ name: fieldName }] }));

  if (DEBUG) console.debug('[VKCLOUD][vision] POST', endpoint, '; type:', type);

  try {
    const res = await requestWithRetry(() =>
      postWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'User-Agent': 'onloc/1.0' },
        body: form,
      })
    );

    const text = await res.text().catch(() => '');
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (DEBUG) {
      console.debug('[VKCLOUD][vision] status:', res.status);
      const hdr = {}; res.headers.forEach((v, k) => { hdr[k] = v; });
      console.debug('[VKCLOUD][vision] resp headers:', hdr);
      if (!res.ok) console.error('[VKCLOUD][vision] resp body:', text?.slice(0, 800));
    }

    if (!res.ok) {
      const reason = `http_${res.status}`;
      if (STRICT) return { allowed: false, raw: json, score: null, reason };
      return skip(`skip_${reason}`, json);
    }

    const parsed = parseSafeToNsfw(json);
    if (parsed.error) {
      if (STRICT) return { allowed: false, raw: json, score: null, reason: parsed.error };
      return skip(parsed.error, json);
    }

    const threshold = Number(process.env.VKCOM_NSFW_THRESHOLD || 0.85);
    const allowed = parsed.nsfwScore < threshold;
    const reason  = allowed ? 'ok' : `nsfw_score>=${threshold}`;
    if (DEBUG) console.debug('[VKCLOUD][vision] safe:', parsed.safe, 'nsfwScore:', parsed.nsfwScore, 'allowed:', allowed);
    return { allowed, raw: json, score: parsed.nsfwScore, reason, skipped: false };
  } catch (err) {
    console.error('[VKCLOUD][vision] fetch error:', err?.name, err?.message);
    if (STRICT) throw err;
    return skip('skip_fetch_error', { error: String(err?.message || err) });
  }
}

export async function checkNsfwUrl(imageUrl) {
  try {
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`fetch_image_${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const filename = imageUrl.split('/').pop() || 'image';
    // contentType из ответа (если есть)
    const ct = r.headers.get('content-type') || mimeFromFilename(filename);
    return await checkNsfwBuffer(buf, filename, ct || undefined);
  } catch (e) {
    console.error('[VKCLOUD][vision] download url error:', e?.message);
    const STRICT = process.env.VKCOM_NSFW_STRICT === '1';
    if (STRICT) throw e;
    return skip('skip_fetch_image', { error: e?.message });
  }
}
