// Probe: extract a TikTok progressive MP4 URL from the embed page.
//
// Approach:
//   1. Fetch https://www.tiktok.com/embed/v2/<id> with a real browser UA.
//      The embed endpoint returns an HTML page that inlines a JSON state
//      blob — same data the on-page React tree mounts from.
//   2. The blob lives inside <script id="__FRONTITY_CONNECT_STATE__"
//      type="application/json">{...}</script>. Newer variants use
//      <script id="SIGI_STATE">{...}</script> (full site) or
//      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">. Embed pages
//      typically expose FRONTITY_CONNECT_STATE first.
//   3. Walk the parsed object for `video.playAddr` / `video.downloadAddr`
//      / `video.urls[*]`. TikTok's CDN URLs require the ttwid cookie
//      and a matching UA + Referer to return bytes (otherwise 403).
//
// Usage:  node scripts/probe-tiktok.mjs <videoId> [--head]
//         node scripts/probe-tiktok.mjs 6718335390845095173
//         node scripts/probe-tiktok.mjs 6718335390845095173 --head
//
// This is investigation-only; it does not touch romfs or the engine.
//
// Note: NODE_TLS_REJECT_UNAUTHORIZED=0 may be needed behind corporate proxies
// (the Switch path uses bundled mbedTLS so this disable is local-only).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) ' +
           'Chrome/124.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const videoId = args.find((a) => !a.startsWith('--')) || '6718335390845095173';
const headProbe = args.includes('--head');

function extractScriptJson(html, id) {
  const re = new RegExp(
    '<script[^>]*\\bid=["\']' + id + '["\'][^>]*>([\\s\\S]*?)</script>',
    'i'
  );
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return { __parseError: String(e), __raw: m[1].slice(0, 500) };
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function findVideoUrls(obj, depth = 0, out = [], seen = new WeakSet()) {
  if (depth > 14 || obj == null) return out;
  if (typeof obj !== 'object') return out;
  if (seen.has(obj)) return out;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const looksLikeUrl =
        /^https?:\/\//.test(v) &&
        (v.includes('tiktokcdn') ||
         v.includes('tiktokv') ||
         v.includes('byteoversea') ||
         /\.(mp4|m3u8)(\?|$)/i.test(v));
      if (looksLikeUrl) out.push({ key: k, url: v });
    } else if (typeof v === 'object') {
      findVideoUrls(v, depth + 1, out, seen);
    }
  }
  return out;
}

async function main() {
  const url = `https://www.tiktok.com/embed/v2/${videoId}`;
  console.log('[probe] GET ' + url);
  const resp = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  console.log('[probe] status:', resp.status, resp.statusText);
  const setCookies = resp.headers.getSetCookie?.() || [];
  if (setCookies.length) {
    console.log('[probe] set-cookie count:', setCookies.length);
    for (const c of setCookies) {
      const name = c.split('=', 1)[0];
      console.log('   ', name);
    }
  }
  const ttwidCookie = setCookies
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('ttwid='));
  if (ttwidCookie) console.log('[probe] ttwid:', ttwidCookie.slice(0, 80) + '…');

  const html = await resp.text();
  console.log('[probe] html bytes:', html.length);

  const candidates = [
    '__FRONTITY_CONNECT_STATE__',
    'SIGI_STATE',
    '__UNIVERSAL_DATA_FOR_REHYDRATION__',
    '__NEXT_DATA__',
  ];
  for (const id of candidates) {
    const found = extractScriptJson(html, id);
    if (found) {
      console.log('[probe] found script blob: #' + id);
      if (found.__parseError) {
        console.log('   parse error:', found.__parseError);
        console.log('   raw head:', found.__raw);
      } else {
        const urls = findVideoUrls(found);
        console.log('   discovered url-like fields:', urls.length);
        for (const u of urls.slice(0, 10)) {
          console.log('     [' + u.key + ']', u.url.slice(0, 140) +
            (u.url.length > 140 ? '…' : ''));
        }
      }
    }
  }

  // Primary extraction path on the embed endpoint: the page renders a
  // bare <video src="..."> tag with the progressive MP4 URL inline.
  // Capture the full URL (no length truncation) and HTML-decode entities.
  const videoTagMatch = html.match(/<video[^>]*\bsrc=["']([^"']+)["']/i);
  let videoUrl = null;
  if (videoTagMatch) {
    videoUrl = decodeEntities(videoTagMatch[1]);
    console.log('[probe] inline <video src> (full):');
    console.log('   ' + videoUrl);
  }

  if (videoUrl && headProbe) {
    console.log('[probe] HEAD-fetching CDN url with ttwid cookie + UA…');
    const headers = {
      'user-agent': UA,
      'referer': 'https://www.tiktok.com/',
      'accept': '*/*',
      'range': 'bytes=0-1023',
    };
    if (ttwidCookie) headers['cookie'] = ttwidCookie;
    try {
      const r2 = await fetch(videoUrl, { headers });
      console.log('[probe] CDN status:', r2.status, r2.statusText);
      console.log('[probe] content-type:', r2.headers.get('content-type'));
      console.log('[probe] content-length:', r2.headers.get('content-length'));
      console.log('[probe] content-range:', r2.headers.get('content-range'));
      const ab = await r2.arrayBuffer();
      const head8 = [...new Uint8Array(ab).slice(0, 12)]
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log('[probe] first 12 bytes:', head8);
      // MP4 should have "ftyp" at bytes 4..7
      const ascii = new TextDecoder('ascii').decode(new Uint8Array(ab).slice(4, 8));
      console.log('[probe] ftyp-window ascii:', JSON.stringify(ascii));
    } catch (e) {
      console.log('[probe] CDN fetch error:', String(e?.message || e));
    }
  }
}

main().catch((e) => {
  console.error('[probe] ERROR:', e);
  process.exit(1);
});
