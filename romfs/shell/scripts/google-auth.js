// Google OAuth 2.0 Limited Input Device flow for Brewser. Page-flow
// variant: drives shell/googleLogin.html.
//
// Limited Input Device flow is Google's RFC 8628 variant. Endpoints:
//   * https://oauth2.googleapis.com/device/code       (device auth)
//   * https://oauth2.googleapis.com/token             (token exchange)
//   * https://brewser.tech/wp-json/brewser/v1/auth/device-mint
//                                                     (Brewser mint route)
//
// The OAuth client registered in Google Cloud Console MUST be of type
// "TVs and Limited Input devices" — desktop / web / mobile client
// types do NOT issue device codes. Scopes: `openid email profile`.
// `openid` is required so Google emits an `id_token` in the /token
// response; the identity/mint tail depends on that.
//
// Identity model:
//   * On successful poll, Google returns an `id_token` alongside the
//     `access_token`. We POST that `id_token` to Brewser's device-mint
//     route, which verifies the signature against Google's JWKS +
//     `aud` against the Switch client id, and returns an HS256
//     envelope `{ token, user: { sub, name, email, picture, exp } }`
//     — the same shape the web popup flow's postMessage receiver
//     saves to `localStorage['brewser_auth']` on the game origin.
//   * Stable unique ID is `sub` from the envelope's user object.
//   * `email`, `name`, `picture` also come from the envelope. This
//     tail does NOT hit Google's /userinfo — the id_token's verified
//     claims are the sole identity source.
//   * The persisted SDMC record ({provider,id,email,name,avatar_url,
//     token,user,saved_at}) matches the shape
//     CONTRACT_switch_auth_record.md's runtime bridge reads to
//     surface the session at `localStorage['brewser_auth']` on Switch.
//
// Persistence: `sdmc:/switch/brewser/shell/auth/google-auth.json`.
// Diagnostic log: `sdmc:/switch/brewser/logs/google-auth.log`.

(function () {
  'use strict';

  var DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
  var TOKEN_URL       = 'https://oauth2.googleapis.com/token';
  // Brewser-owned mint route. Trades a Google id_token for the HS256
  // envelope the app-side read seam expects. Contracts:
  //   brewser-runtime-v8/docs/CONTRACT_switch_auth_record.md
  //   brewser-WP-Plugins/.../brewser-auth/CONTRACT_device_mint_route.md
  var MINT_URL        = 'https://brewser.tech/wp-json/brewser/v1/auth/device-mint';

  // openid → emits sub. email → email field on /userinfo. profile →
  // name + picture. All three are on Google's Limited Input Device
  // allowlist.
  var SCOPES = 'openid email profile';
  // RFC 8628 standard grant_type identifier for Device Authorization
  // Grant. Google accepted the legacy `http://oauth.net/grant_type/device/1.0`
  // for older TV clients, but newly-created clients (2024+) dispatch to
  // authorization_code grant validation on the legacy value, producing
  // a "Missing required parameter: code" error. The standard urn form
  // is what current Google servers route to the device-code handler.
  var DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

  var AUTH_DIR  = 'sdmc:/switch/brewser/shell/auth/';
  var AUTH_PATH = AUTH_DIR + 'google-auth.json';

  var AVATAR_STEM       = 'google-avatar';
  var AVATAR_THUMB_STEM = 'google-avatar_64x64';
  var AVATAR_MAIN_PX    = 200;
  var AVATAR_THUMB_PX   = 64;
  var AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  function avatarMainPath(ext)  { return AUTH_DIR + AVATAR_STEM       + '.' + ext; }
  function avatarThumbPath(ext) { return AUTH_DIR + AVATAR_THUMB_STEM + '.' + ext; }

  var LOG_DIR  = 'sdmc:/switch/brewser/logs/';
  var LOG_PATH = LOG_DIR + 'google-auth.log';

  var MAX_POLL_SECONDS = 15 * 60;

  // ============================================================
  // Diagnostic log
  // ============================================================
  var _logBuffer = [];
  function log(line) {
    var ts = new Date().toISOString();
    _logBuffer.push('[' + ts + '] ' + line);
    try { console.debug('[google-auth] ' + line); } catch (_) {}
    flushLog();
  }
  function flushLog() {
    if (_logBuffer.length === 0) return;
    if (typeof Switch === 'undefined' || !Switch) return;
    var chunk = _logBuffer.join('\n') + '\n';
    _logBuffer = [];
    try {
      try { Switch.mkdirSync(LOG_DIR); } catch (_) {}
      if (typeof Switch.appendFileSync === 'function') {
        Switch.appendFileSync(LOG_PATH, chunk);
      } else {
        var existing = '';
        try {
          var raw = Switch.readFileSync(LOG_PATH);
          if (raw) existing = new TextDecoder().decode(raw);
        } catch (_) {}
        Switch.writeFileSync(LOG_PATH, existing + chunk);
      }
    } catch (e) {
      try { console.debug('[google-auth] log write failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  }
  log('=== google-auth.js loaded ===');

  // ============================================================
  // DOM refs
  // ============================================================
  var body;
  var hintInput, submitBtn, emailErrorEl;
  var verificationUrlEl, userCodeEl, pollStatusEl;
  var successEmailEl, successNameEl, successSubEl, successAvatarEl, logoutBtn;
  var errorMessageEl;

  function captureRefs() {
    body = document.body;
    if (!body) return false;
    hintInput         = document.getElementById('auth-hint');
    submitBtn         = document.getElementById('auth-submit-email');
    emailErrorEl      = document.getElementById('auth-email-error');
    verificationUrlEl = document.getElementById('auth-verification-url');
    userCodeEl        = document.getElementById('auth-user-code');
    pollStatusEl      = document.getElementById('auth-poll-status');
    successEmailEl    = document.getElementById('auth-success-email');
    successNameEl     = document.getElementById('auth-success-name');
    successSubEl      = document.getElementById('auth-success-sub');
    successAvatarEl   = document.getElementById('auth-success-avatar');
    logoutBtn         = document.getElementById('auth-logout');
    errorMessageEl    = document.getElementById('auth-error-message');
    return !!(hintInput && submitBtn);
  }

  var pollCancelToken = null;
  var flowInFlight = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function getClientId() {
    if (!body) return '';
    return (body.getAttribute('data-google-client-id') || '').trim();
  }

  // Google's TV/Limited-Input Device flow requires `client_secret` on
  // the /token poll body, unlike RFC 8628 which permits public clients.
  // The value comes through the same template-substitution pipeline as
  // the client id — see browser-resource-loader.ts's
  // `<browser-config-google-client-secret/>` handler.
  function getClientSecret() {
    if (!body) return '';
    return (body.getAttribute('data-google-client-secret') || '').trim();
  }

  function isClientIdConfigured(cid) {
    if (!cid) return false;
    if (cid.indexOf('REPLACE_ME') === 0) return false;
    // Google client ids are typically "<num>-<hash>.apps.googleusercontent.com"
    return cid.length >= 10;
  }

  function isClientSecretConfigured(cs) {
    if (!cs) return false;
    if (cs.indexOf('REPLACE_ME') === 0) return false;
    // Google client secrets are ~28 chars starting with `GOCSPX-`.
    return cs.length >= 10;
  }

  function setStage(stage) {
    log('setStage ' + stage);
    if (!body) return;
    body.setAttribute('data-auth-stage', stage);
    try {
      body.classList.remove('auth-stage-tick');
      body.classList.add('auth-stage-tick');
    } catch (_) {}
    try { if (typeof globalThis.__swbRepaint === 'function') globalThis.__swbRepaint(); } catch (_) {}
  }

  function setInlineError(msg) { if (emailErrorEl) emailErrorEl.textContent = msg; }
  function setPollStatus(msg, kind) {
    if (!pollStatusEl) return;
    pollStatusEl.textContent = msg;
    pollStatusEl.classList.remove('auth-poll-status--error');
    pollStatusEl.classList.remove('auth-poll-status--ok');
    if (kind === 'error') pollStatusEl.classList.add('auth-poll-status--error');
    if (kind === 'ok')    pollStatusEl.classList.add('auth-poll-status--ok');
  }
  function showErrorStage(msg) {
    log('error stage: ' + msg);
    if (errorMessageEl) errorMessageEl.textContent = msg;
    setStage('error');
  }

  function formBody(obj) {
    var parts = [];
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return parts.join('&');
  }
  function trimForLog(s, limit) {
    if (s == null) return '(null)';
    var str = String(s); var max = limit || 500;
    return str.length > max ? (str.slice(0, max) + '…[+' + (str.length - max) + ' chars]') : str;
  }
  async function readJsonWithLog(resp, label) {
    var text = '';
    try { text = await resp.text(); } catch (e) { log(label + ' .text() threw: ' + (e && e.message ? e.message : String(e))); return null; }
    log(label + ' status=' + resp.status
      + ' ct=' + (resp.headers && resp.headers.get ? resp.headers.get('content-type') : '?')
      + ' body=' + trimForLog(text, 8192));
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { log(label + ' JSON.parse threw: ' + (e && e.message ? e.message : String(e))); return null; }
  }

  function loadStoredRecord() {
    try {
      var raw = Switch.readFileSync(AUTH_PATH);
      if (!raw) return null;
      var parsed = JSON.parse(new TextDecoder().decode(raw));
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
      return parsed;
    } catch (e) { log('loadStoredRecord failed: ' + (e && e.message ? e.message : String(e))); return null; }
  }
  function persistRecord(record) {
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
      Switch.writeFileSync(AUTH_PATH, JSON.stringify(record, null, 2));
      log('persisted record id=' + record.id + ' email=' + record.email);
      return true;
    } catch (e) {
      log('persistRecord failed: ' + (e && e.message ? e.message : String(e)));
      setInlineError('Failed to persist login: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }
  function clearStoredRecord() {
    try { Switch.writeFileSync(AUTH_PATH, '{}'); log('cleared stored record'); }
    catch (e) { log('clearStoredRecord failed: ' + (e && e.message ? e.message : String(e))); }
    for (var i = 0; i < AVATAR_EXTS.length; i++) {
      var ext = AVATAR_EXTS[i];
      try { Switch.writeFileSync(avatarMainPath(ext),  new Uint8Array(0)); } catch (_) {}
      try { Switch.writeFileSync(avatarThumbPath(ext), new Uint8Array(0)); } catch (_) {}
    }
    // Drop the "one active session" pointer too. See github-auth.js's
    // clearStoredRecord for the rationale (login.html keys its
    // logged-in card on `active.json` AND a populated provider record).
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.clearActiveProvider === 'function') {
      globalThis.__swbAuth.clearActiveProvider();
    }
  }

  // ------------------------------------------------------------------
  // Avatar download — Google `picture` URL is a public CDN link
  // (lh3.googleusercontent.com). Append `=sNN` to the URL path to ask
  // for an NN-pixel rendering; that's Google's canonical size-suffix
  // grammar for these URLs.
  // ------------------------------------------------------------------
  function avatarFileExistsAt(path) {
    if (!path) return false;
    try { var probe = Switch.readFileSync(path); return !!(probe && probe.byteLength > 0); }
    catch (_) { return false; }
  }
  function extFromContentType(ct) {
    if (!ct) return null;
    var lower = String(ct).toLowerCase().split(';')[0].trim();
    if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
    if (lower === 'image/png')  return 'png';
    if (lower === 'image/gif')  return 'gif';
    if (lower === 'image/webp') return 'webp';
    return null;
  }
  function extFromMagicBytes(buf) {
    if (!buf || buf.byteLength < 4) return null;
    var b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b.byteLength >= 12
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    return null;
  }

  // Append `=sNN` (or replace an existing suffix). Google avatar URLs
  // look like `…/photo.jpg` or `…/photo.jpg=s96-c` — the trailing
  // `=sNN[-c]` is a size directive Google honors server-side. We
  // strip any existing one + write our own.
  function withGoogleSize(url, sizePx) {
    if (!url) return url;
    var stripped = url.replace(/=s\d+(?:-c)?$/i, '');
    return stripped + '=s' + sizePx;
  }

  async function fetchAvatarAtSize(url, sizePx, pathBuilder) {
    var sized = withGoogleSize(url, sizePx);
    log('fetchAvatarAtSize GET ' + sized);
    var resp;
    try { resp = await globalThis.fetch(sized); }
    catch (e) { log('fetchAvatarAtSize fetch threw: ' + (e && e.message ? e.message : String(e))); return null; }
    if (!resp.ok) { log('fetchAvatarAtSize HTTP ' + resp.status); return null; }
    var ct = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : '';
    var buf;
    try { buf = await resp.arrayBuffer(); }
    catch (e) { log('fetchAvatarAtSize arrayBuffer threw: ' + (e && e.message ? e.message : String(e))); return null; }
    var ext = extFromContentType(ct) || extFromMagicBytes(buf) || 'png';
    var path = pathBuilder(ext);
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
      Switch.writeFileSync(path, buf);
      log('fetchAvatarAtSize wrote ' + buf.byteLength + ' bytes (ct=' + (ct || '?') + ', ext=' + ext + ') to ' + path);
      return { path: path, ext: ext };
    } catch (e) {
      log('fetchAvatarAtSize write threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  async function downloadAvatar(url) {
    if (!url) return null;
    var main = await fetchAvatarAtSize(url, AVATAR_MAIN_PX, avatarMainPath);
    if (!main) return null;
    var thumb = await fetchAvatarAtSize(url, AVATAR_THUMB_PX, avatarThumbPath);
    return { mainPath: main.path, thumbPath: thumb ? thumb.path : null };
  }

  async function ensureAvatarFresh(record) {
    if (!record || !record.avatar_url) return;
    var urlMatches = record.avatar_downloaded_url === record.avatar_url;
    var localOk = avatarFileExistsAt(record.avatar_local_path);
    if (urlMatches && localOk) {
      log('ensureAvatarFresh: cached ' + record.avatar_local_path + ' already matches avatar_url');
      return;
    }
    var prevMain  = record.avatar_local_path || '';
    var prevThumb = record.avatar_local_thumb_path || '';
    var result = await downloadAvatar(record.avatar_url);
    if (!result) return;
    if (prevMain && prevMain !== result.mainPath) {
      try { Switch.writeFileSync(prevMain, new Uint8Array(0)); } catch (_) {}
    }
    if (prevThumb && prevThumb !== result.thumbPath) {
      try { Switch.writeFileSync(prevThumb, new Uint8Array(0)); } catch (_) {}
    }
    record.avatar_downloaded_url    = record.avatar_url;
    record.avatar_local_path        = result.mainPath;
    record.avatar_local_thumb_path  = result.thumbPath || '';
    persistRecord(record);
  }

  // ============================================================
  // Google device flow
  // ============================================================
  async function requestDeviceCode(clientId) {
    log('POST ' + DEVICE_CODE_URL + ' client_id=' + clientId);
    var resp;
    try {
      resp = await globalThis.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: formBody({ client_id: clientId, scope: SCOPES }),
      });
    } catch (e) {
      log('device/code fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Network error: ' + (e && e.message ? e.message : String(e)));
    }
    var data = await readJsonWithLog(resp, 'device/code');
    if (!resp.ok) {
      var msg = data && (data.error_description || data.error)
        ? (data.error_description || data.error)
        : ('HTTP ' + resp.status);
      throw new Error('Device authorization failed: ' + msg);
    }
    if (!data || !data.device_code || !data.user_code) {
      throw new Error('Device authorization returned malformed payload');
    }
    return data;
  }

  async function pollForToken(clientId, clientSecret, deviceCode, intervalSec, expiresInSec, cancelToken) {
    var interval = Math.max(1, intervalSec || 5);
    var deadline = Date.now() + Math.min(expiresInSec || 900, MAX_POLL_SECONDS) * 1000;
    log('poll loop start interval=' + interval + 's expires_in=' + expiresInSec + 's');

    var pollCount = 0;
    while (Date.now() < deadline) {
      if (cancelToken !== pollCancelToken) { log('poll cancelled'); return { cancelled: true }; }
      await sleep(interval * 1000);
      if (cancelToken !== pollCancelToken) { log('poll cancelled (post-sleep)'); return { cancelled: true }; }
      pollCount++;

      var resp;
      try {
        resp = await globalThis.fetch(TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          // client_secret is required by Google's TV/Limited-Input Device
          // flow at /token — the standard RFC 8628 public-client shape
          // (client_id + device_code + grant_type) triggers "Missing
          // required parameter: client_secret" from Google's server.
          body: formBody({
            client_id: clientId,
            client_secret: clientSecret,
            device_code: deviceCode,
            grant_type: DEVICE_GRANT_TYPE,
          }),
        });
      } catch (e) {
        log('poll #' + pollCount + ' fetch threw: ' + (e && e.message ? e.message : String(e)));
        setPollStatus('Network blip — retrying…', 'error');
        continue;
      }

      var data = await readJsonWithLog(resp, 'poll #' + pollCount);

      if (resp.ok && data && data.access_token) {
        log('poll #' + pollCount + ' SUCCESS — access_token len=' + (data.access_token ? data.access_token.length : 0));
        return { tokens: data };
      }

      var err = data && data.error ? data.error : ('HTTP ' + resp.status);
      if (err === 'authorization_pending') { setPollStatus('Waiting for confirmation…'); continue; }
      if (err === 'slow_down') {
        interval += 5;
        setPollStatus('Slowing down — polling every ' + interval + 's…');
        log('poll slow_down — new interval=' + interval + 's');
        continue;
      }
      if (err === 'access_denied') return { error: 'You denied the sign-in request.' };
      if (err === 'expired_token') return { error: 'The one-time code expired. Reload to retry.' };
      log('poll terminal error: ' + err);
      return { error: 'OAuth error: ' + err };
    }
    log('poll deadline reached');
    return { error: 'Authentication timed out. Reload to retry.' };
  }

  // ============================================================
  // Envelope mint (Brewser-owned) — replaces the identity fetch
  // ============================================================
  //
  // POST the id_token from the poll response to /auth/device-mint.
  // On 200 with a well-formed envelope, resolve with
  // `{ ok: true, token, user }`. On any HTTP/protocol failure,
  // resolve with `{ ok: false, error: <message> }` so the caller can
  // report to the panel without an exception boundary. A network
  // throw is left to bubble — the caller distinguishes it from
  // server-side rejects.
  //
  // Never logs the raw id_token (only its length) — the token is a
  // JWT and would leak sub/email if written to the diagnostic log.
  async function mintEnvelope(idToken) {
    log('POST ' + MINT_URL + ' id_token_len=' + idToken.length);
    var resp = await globalThis.fetch(MINT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ id_token: idToken }),
    });
    var data = await readJsonWithLog(resp, 'device-mint');
    if (!resp.ok) {
      var msg = data && data.error ? String(data.error) : ('HTTP ' + resp.status);
      log('device-mint terminal error: ' + msg);
      return { ok: false, error: 'Sign-in server rejected the request: ' + msg };
    }
    if (!data || typeof data.token !== 'string' || data.token.length === 0) {
      log('device-mint response missing token');
      return { ok: false, error: 'Sign-in server returned a malformed response (no token).' };
    }
    if (!data.user || typeof data.user !== 'object'
        || typeof data.user.sub !== 'string' || data.user.sub.length === 0) {
      log('device-mint response missing user.sub');
      return { ok: false, error: 'Sign-in server returned a malformed response (no user.sub).' };
    }
    return { ok: true, token: data.token, user: data.user };
  }

  // ============================================================
  // Flow entry points
  // ============================================================
  function showSuccess(record) {
    captureRefs();
    if (successEmailEl) successEmailEl.textContent = record.email || '(not set)';
    if (successNameEl)  successNameEl.textContent  = record.name || '(no display name)';
    if (successSubEl)   successSubEl.textContent   = record.id;
    if (successAvatarEl) {
      var localPath = record.avatar_local_path || '';
      if (localPath && avatarFileExistsAt(localPath)) {
        successAvatarEl.src = localPath;
      } else if (record.avatar_url) {
        successAvatarEl.src = withGoogleSize(record.avatar_url, AVATAR_MAIN_PX);
      } else {
        successAvatarEl.removeAttribute('src');
      }
    }
    setStage('success');
  }

  async function startDeviceFlow(loginHint) {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) {
      showErrorStage('Google OAuth client_id is not configured. Set "googleOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    var clientSecret = getClientSecret();
    if (!isClientSecretConfigured(clientSecret)) {
      showErrorStage('Google OAuth client_secret is not configured. Set "googleOAuthClientSecret" in config.json (current: ' + (clientSecret ? '(present but too short)' : '(empty)') + ').');
      return;
    }
    log('startDeviceFlow hint="' + (loginHint || '') + '"');

    captureRefs();
    if (verificationUrlEl) verificationUrlEl.textContent = '';
    if (userCodeEl) userCodeEl.textContent = '…';
    setPollStatus('Requesting one-time code…');
    setStage('device');

    var device;
    try { device = await requestDeviceCode(clientId); }
    catch (e) {
      log('startDeviceFlow caught: ' + (e && e.message ? e.message : String(e)));
      setStage('email');
      setInlineError(e && e.message ? e.message : String(e));
      return;
    }

    captureRefs();
    var url = device.verification_url || device.verification_uri || 'https://www.google.com/device';
    log('device response — user_code=' + device.user_code + ' url=' + url);
    if (verificationUrlEl) {
      verificationUrlEl.textContent = url;
      try { verificationUrlEl.setAttribute('href', url); } catch (_) {}
    }
    if (userCodeEl) userCodeEl.textContent = device.user_code;
    setPollStatus('Waiting for confirmation…');

    var myToken = {};
    pollCancelToken = myToken;
    var result = await pollForToken(clientId, clientSecret, device.device_code, device.interval, device.expires_in, myToken);

    if (result.cancelled) return;
    if (result.error)    { setPollStatus(result.error, 'error'); return; }
    if (!result.tokens)  { setPollStatus('Unexpected end of polling.', 'error'); return; }

    // Capture the id_token from the poll response. `openid` in SCOPES
    // guarantees Google issues one (confirmed on hardware 2026-07-08:
    // Google's TV client returns id_token alongside access_token). If
    // the response is somehow missing it, the mint route can't verify
    // identity — bail with an explicit error, per the contract's
    // "persist-only-on-success" invariant.
    var idToken = result.tokens && typeof result.tokens.id_token === 'string'
      ? result.tokens.id_token
      : '';
    if (!idToken) {
      log('mint precondition failed: no id_token in poll response');
      setPollStatus('Sign-in incomplete: identity token missing.', 'error');
      return;
    }

    // Trade id_token for a Brewser envelope. Contract HARD INVARIANT
    // (persist-only-on-success): on ANY failure — network unreachable,
    // non-200, malformed JSON, missing token/user.sub — show an error
    // and persist NOTHING. No google-auth.json write, no active.json
    // touch, no avatar fetch, prior-session record left in place. The
    // sequence below is the only path to persistRecord() and each
    // early-return exits before touching any storage.
    setPollStatus('Verifying identity with Brewser…');
    var mint;
    try {
      mint = await mintEnvelope(idToken);
    } catch (e) {
      log('mintEnvelope threw (network): ' + (e && e.message ? e.message : String(e)));
      setPollStatus('Could not reach brewser.tech to complete sign-in.', 'error');
      return;
    }
    if (!mint.ok) {
      setPollStatus(mint.error, 'error');
      return;
    }

    // Build the contract-shape SDMC record.
    //   Top-level id/email/name/avatar_url mirror `user` for the
    //     shell login picker (which does not decode envelopes).
    //   token + user are the envelope the runtime bridge (#102)
    //     surfaces to localStorage['brewser_auth'].
    //   No access_token / refresh_token / token_type / scope / login —
    //     see the contract's removed-fields list. A stored Google
    //     access_token would be a needless secret at rest and nothing
    //     reads it now that /userinfo is out of the identity path.
    var record = {
      provider:   'google',
      id:         mint.user.sub,
      email:      (typeof mint.user.email === 'string' && mint.user.email) || loginHint || '',
      name:       typeof mint.user.name    === 'string' ? mint.user.name    : '',
      avatar_url: typeof mint.user.picture === 'string' ? mint.user.picture : '',
      token:      mint.token,
      user:       mint.user,
      saved_at:   Date.now(),
    };
    if (!persistRecord(record)) return;
    await ensureAvatarFresh(record);
    // Enforce "one service login at a time" — wipe every OTHER
    // provider's auth artifacts and stamp `active.json` so the central
    // login dashboard + toolbar avatar slot now point at google.
    if (globalThis.__swbAuth) {
      globalThis.__swbAuth.wipeOthers('google');
      globalThis.__swbAuth.setActiveProvider('google');
    }
    showSuccess(record);
  }

  async function trySilentVerify() {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) return null;
    var stored = loadStoredRecord();
    if (!stored) return null;

    // Contract §"Silent-verify decision": local expiry check against
    // the envelope's `user.exp`, no network. The envelope was minted
    // by /auth/device-mint and is trusted as the sole source of
    // validity — `exp` is HMAC-signed inside the `token`.
    //
    // Pre-envelope records (from before the tail rewrite) lack the
    // `user.exp` field and are correctly treated as expired here —
    // clearStoredRecord drops them so the next boot forces a fresh
    // sign-in in the new shape. This is the intended migration path.
    var expUnix = stored.user && Number(stored.user.exp);
    var expOk = Number.isFinite(expUnix) && expUnix * 1000 > Date.now();
    if (!expOk) {
      log('trySilentVerify — envelope missing or expired (exp='
        + (stored.user && stored.user.exp) + '); clearing record');
      clearStoredRecord();
      return null;
    }

    log('trySilentVerify — envelope still valid (exp=' + expUnix + ')');
    // Re-assert the active-session pointer for the case a user opens
    // googleLogin.html directly (bypassing the central dashboard) —
    // same rationale as the fresh-mint path.
    if (globalThis.__swbAuth) {
      globalThis.__swbAuth.wipeOthers('google');
      globalThis.__swbAuth.setActiveProvider('google');
    }
    return stored;
  }

  function wireEvents() {
    if (submitBtn) {
      submitBtn.addEventListener('click', async function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        if (flowInFlight) { log('Continue tap ignored — flow already in flight'); return; }
        flowInFlight = true;
        try { submitBtn.setAttribute('disabled', ''); } catch (_) {}
        var hint = (hintInput && hintInput.value || '').trim();
        setInlineError('');
        try { await startDeviceFlow(hint); }
        finally {
          flowInFlight = false;
          try { submitBtn.removeAttribute('disabled'); } catch (_) {}
        }
      });
    }
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        clearStoredRecord();
        setStage('email');
        if (hintInput) hintInput.value = '';
        setInlineError('');
      });
    }
  }

  async function boot() {
    log('boot');
    if (!captureRefs()) {
      log('captureRefs failed at boot — retrying in 100ms');
      setTimeout(function () {
        if (!captureRefs()) { log('captureRefs failed second time — giving up'); return; }
        wireEvents();
        hydrate();
      }, 100);
      return;
    }
    wireEvents();
    await hydrate();
  }

  async function hydrate() {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) {
      showErrorStage('Google OAuth client_id is not configured. Set "googleOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    try {
      var record = await trySilentVerify();
      if (record && record.id) { showSuccess(record); return; }
    } catch (e) { log('hydrate threw: ' + (e && e.message ? e.message : String(e))); }
    setStage('email');
  }

  boot();
})();
