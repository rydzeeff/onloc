// /lib/vkcloud/oauth.js
// OAuth2 client_credentials для VK Cloud Vision (MCS)
// Документация: mcs.mail.ru → OAuth endpoint: https://mcs.mail.ru/auth/oauth/v1/token
// ENV (обяз.): VKCOM_CLIENT_ID, VKCOM_CLIENT_SECRET
// ENV (опц.):  VKCOM_TOKEN_URL, VKCOM_HTTP_TIMEOUT_MS, VKCOM_NSFW_STRICT, VKCOM_DEBUG


let _cachedToken = null;
let _cachedTokenExpiresAt = 0;

const STATIC_TOKEN = process.env.VKCOM_VISION_TOKEN || null;
const DEBUG = process.env.VKCOM_DEBUG === '1';
const STRICT = process.env.VKCOM_NSFW_STRICT === '1';
const TIMEOUT_MS = Number(process.env.VKCOM_HTTP_TIMEOUT_MS || 7000);

function redact(s, keep = 8) {
  if (!s) return '';
  const head = s.slice(0, keep);
  return `${head}…(${s.length})`;
}

export async function getVkAccessToken() {
  // 1) Если задан статический сервисный токен — просто возвращаем его
  if (STATIC_TOKEN) {
    if (DEBUG) {
      console.debug('[VKCLOUD][oauth] Using static VKCOM_VISION_TOKEN');
    }
    return STATIC_TOKEN;
  }
  const clientId = process.env.VKCOM_CLIENT_ID;
  const clientSecret = process.env.VKCOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('[VKCLOUD][oauth] Missing VKCOM_CLIENT_ID/VKCOM_CLIENT_SECRET');
    if (STRICT) throw new Error('VKCOM credentials not configured');
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _cachedTokenExpiresAt - 30) {
    if (DEBUG) console.debug('[VKCLOUD][oauth] cache hit; expAt:', _cachedTokenExpiresAt);
    return _cachedToken;
  }

  const tokenUrl =
    process.env.VKCOM_TOKEN_URL ||
    'https://mcs.mail.ru/auth/oauth/v1/token'; // ← корректный OAuth endpoint по мануалу

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

  if (DEBUG) {
    console.debug('[VKCLOUD][oauth] POST', tokenUrl, 'timeout:', TIMEOUT_MS, 'ms');
  }

  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'onloc/1.0',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: controller.signal,
    });
    clearTimeout(to);

    const text = await res.text().catch(() => '');
    let json; try { json = JSON.parse(text); } catch { json = null; }

    if (DEBUG) {
      console.debug('[VKCLOUD][oauth] status:', res.status);
      const hdr = {}; res.headers.forEach((v, k) => { hdr[k] = v; });
      console.debug('[VKCLOUD][oauth] resp headers:', hdr);
      if (!res.ok) console.error('[VKCLOUD][oauth] resp body:', text?.slice(0, 800));
    }

    if (!res.ok) {
      const msg = `OAuth HTTP ${res.status}`;
      if (STRICT) throw new Error(msg);
      return null;
    }

    const accessToken = json?.access_token;
    const expiresIn = Number(json?.expires_in || 3600); // по доке токен ~1 час
    if (!accessToken) {
      console.error('[VKCLOUD][oauth] no access_token in response');
      if (STRICT) throw new Error('no access_token');
      return null;
    }

    _cachedToken = accessToken;
    _cachedTokenExpiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    if (DEBUG) {
      console.debug('[VKCLOUD][oauth] token:', redact(accessToken, 12), 'expiresIn:', expiresIn);
    }
    return accessToken;
  } catch (err) {
    clearTimeout(to);
    const c = err?.cause || {};
    console.error('[VKCLOUD][oauth] fetch error:',
      err?.name, err?.message,
      { code: c.code, syscall: c.syscall, hostname: c.hostname, address: c.address, port: c.port }
    );
    if (STRICT) throw err;
    return null;
  }
}
