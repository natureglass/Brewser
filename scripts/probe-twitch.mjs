// Anonymous Twitch HLS probe — matches what an inline page script could do.
// Args: node probe-twitch.mjs <channel-login>
const CHANNEL = (process.argv[2] || 'dino_xx').toLowerCase();
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // public web player client-id
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function gqlPlaybackAccessToken(login) {
  const body = {
    operationName: 'PlaybackAccessToken',
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712',
      },
    },
    variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'site' },
  };
  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const t = j?.data?.streamPlaybackAccessToken;
  if (!t) throw new Error('no streamPlaybackAccessToken: ' + JSON.stringify(j).slice(0, 400));
  return { value: t.value, signature: t.signature };
}

function usherUrl(channel, tok) {
  const params = new URLSearchParams({
    allow_source: 'true',
    fast_bread: 'true',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    sig: tok.signature,
    token: tok.value,
    cdm: 'wv',
    player_version: '1.30.0',
    p: String(Math.floor(Math.random() * 1e6)),
  });
  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channel)}.m3u8?${params}`;
}

(async () => {
  console.log('# channel:', CHANNEL);
  const tok = await gqlPlaybackAccessToken(CHANNEL);
  console.log('# access token ok, sig =', tok.signature, 'value chars =', tok.value.length);

  const master = usherUrl(CHANNEL, tok);
  console.log('# master URL chars:', master.length);

  const r = await fetch(master, { headers: { 'User-Agent': UA } });
  console.log('# master HTTP', r.status, 'content-type:', r.headers.get('content-type'));
  if (!r.ok) {
    const t = await r.text();
    console.log(t.slice(0, 500));
    process.exit(1);
  }
  const masterBody = await r.text();
  console.log('# master.m3u8 bytes:', masterBody.length);
  console.log('--- master.m3u8 (full) ---');
  console.log(masterBody);
  console.log('--- end master ---');

  // Pick the first media playlist URL.
  const variantLine = masterBody.split('\n').find(l => l.startsWith('https://'));
  if (!variantLine) {
    console.log('# no variant URL in master');
    process.exit(1);
  }
  console.log('# fetching first variant:', variantLine.slice(0, 120));
  const mr = await fetch(variantLine.trim(), { headers: { 'User-Agent': UA } });
  console.log('# variant HTTP', mr.status, 'content-type:', mr.headers.get('content-type'));
  const mediaBody = await mr.text();
  console.log('# variant bytes:', mediaBody.length);
  const lines = mediaBody.split('\n');
  console.log('--- variant head (first 30 lines) ---');
  console.log(lines.slice(0, 30).join('\n'));
  console.log('--- variant tail (last 12 lines) ---');
  console.log(lines.slice(-12).join('\n'));

  // First .ts segment.
  const segLine = lines.find(l => l.startsWith('https://') && l.includes('.ts'));
  if (segLine) {
    console.log('# fetching first segment:', segLine.slice(0, 100));
    const sr = await fetch(segLine.trim(), { headers: { 'User-Agent': UA }, method: 'HEAD' });
    console.log('# segment HEAD HTTP', sr.status, 'content-type:', sr.headers.get('content-type'), 'len:', sr.headers.get('content-length'));
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
