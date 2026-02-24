// /pages/api/vkcloud/vk-nsfw-check.js
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

import { checkNsfwBuffer, checkNsfwUrl } from '../../../lib/vkcloud/visionNsfw.js';

function dataUrlToBufferAndMime(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const meta = dataUrl.slice(5, comma); // "image/webp;base64"
  const mime = (meta.split(';')[0]) || 'application/octet-stream';
  try {
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    return { buf, mime };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const STRICT = process.env.VKCOM_NSFW_STRICT === '1';
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const t0 = Date.now();
  try {
    const { imageBase64, imageUrl, filename } = req.body || {};
    console.debug('[NSFW][api] start; base64:', !!imageBase64, 'url:', !!imageUrl, 'file:', filename);

    let result;
    if (imageUrl) {
      result = await checkNsfwUrl(imageUrl);
    } else {
      const parsed = dataUrlToBufferAndMime(imageBase64);
      if (!parsed) return res.status(400).json({ error: 'Bad imageBase64' });
      result = await checkNsfwBuffer(parsed.buf, filename || 'image', parsed.mime);
    }

    const dt = Date.now() - t0;
    console.debug('[NSFW][api] done in', dt, 'ms; allowed:', result?.allowed, 'score:', result?.score, 'reason:', result?.reason, 'skipped:', !!result?.skipped);

    return res.status(200).json({
      allowed: result.allowed,
      score: result.score,
      reason: result.reason,
      skipped: !!result.skipped,
      diag: result?.raw && typeof result.raw === 'object' ? (result.raw.error ? { error: result.raw.error } : null) : null,
    });
  } catch (e) {
    const msg = e?.message || 'Unexpected error';
    console.error('[NSFW][api] ERROR:', msg);
    if (STRICT) return res.status(500).json({ error: msg });
    console.warn('[NSFW][api] SKIP on error:', msg);
    return res.status(200).json({ allowed: true, score: null, reason: 'skip_on_error', skipped: true, diag: { error: msg } });
  }
}
