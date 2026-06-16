// Google OAuth 2.0 Limited Input Device flow for Brewser. Page-flow
// variant: drives shell/googleLogin.html.
//
// Limited Input Device flow is Google's RFC 8628 variant — same shape
// as GitHub's, except the grant_type identifier is the legacy
// `http://oauth.net/grant_type/device/1.0` (not the standard
// `urn:ietf:params:oauth:grant-type:device_code`). Endpoints:
//   * https://oauth2.googleapis.com/device/code
//   * https://oauth2.googleapis.com/token
//   * https://openidconnect.googleapis.com/v1/userinfo
//
// The OAuth client registered in Google Cloud Console MUST be of type
// "TVs and Limited Input devices" — desktop / web / mobile client
// types do NOT issue device codes. Scopes are restricted to a small
// allowlist; `openid email profile` is supported and that's all we
// need for the identity story (sub / email / name / picture).
//
// Identity model:
//   * Stable unique ID is `sub` from /userinfo (an opaque Google
//     account id).
//   * `email` — the user's primary verified email.
//   * `name` — display name.
//   * `picture` — public CDN URL for the avatar; downloaded next to
//     google-auth.json as google-avatar.<ext> + google-avatar_64x64.<ext>.
//
// Persistence: `sdmc:/switch/brewser/shell/auth/google-auth.json`.
// Diagnostic log: `sdmc:/switch/brewser/logs/google-auth.log`.

(function () {
  'use strict';

  var DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
  var TOKEN_URL       = 'https://oauth2.googleapis.com/token';
  var USERINFO_URL    = 'https://openidconnect.googleapis.com/v1/userinfo';

  // openid → emits sub. email → email field on /userinfo. profile →
  // name + picture. All three are on Google's Limited Input Device
  // allowlist.
  var SCOPES = 'openid email profile';
  // Google's device-flow docs explicitly call out this legacy
  // grant_type identifier; the RFC 8628 standard string isn't
  // accepted by the limited-input token endpoint.
  var DEVICE_GRANT_TYPE = 'http://oauth.net/grant_type/device/1.0';

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

  function isClientIdConfigured(cid) {
    if (!cid) return false;
    if (cid.indexOf('REPLACE_ME') === 0) return false;
    // Google client ids are typically "<num>-<hash>.apps.googleusercontent.com"
    return cid.length >= 10;
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
      + ' body=' + trimForLog(text));
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

  async function pollForToken(clientId, deviceCode, intervalSec, expiresInSec, cancelToken) {
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
          body: formBody({
            client_id: clientId,
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
  // Identity fetch
  // ============================================================
  async function fetchUserIdentity(accessToken) {
    log('GET ' + USERINFO_URL);
    var resp;
    try {
      resp = await globalThis.fetch(USERINFO_URL, {
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' },
      });
    } catch (e) {
      log('/userinfo fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Google /userinfo network error: ' + (e && e.message ? e.message : String(e)));
    }
    var user = await readJsonWithLog(resp, '/userinfo');
    if (!resp.ok) throw new Error('Google /userinfo failed: HTTP ' + resp.status);
    if (!user || typeof user.sub !== 'string') throw new Error('Google /userinfo response missing sub');

    return {
      id:         user.sub,
      login:      '',
      name:       typeof user.name  === 'string' ? user.name  : '',
      email:      typeof user.email === 'string' ? user.email : '',
      avatar_url: typeof user.picture === 'string' ? user.picture : '',
    };
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
    var result = await pollForToken(clientId, device.device_code, device.interval, device.expires_in, myToken);

    if (result.cancelled) return;
    if (result.error)    { setPollStatus(result.error, 'error'); return; }
    if (!result.tokens)  { setPollStatus('Unexpected end of polling.', 'error'); return; }

    setPollStatus('Fetching Google user info…');
    var user;
    try { user = await fetchUserIdentity(result.tokens.access_token); }
    catch (e) {
      log('fetchUserIdentity caught: ' + (e && e.message ? e.message : String(e)));
      setPollStatus(e && e.message ? e.message : String(e), 'error');
      return;
    }

    var record = {
      provider: 'google',
      id: user.id,
      login: '',
      email: user.email || loginHint || '',
      name: user.name,
      avatar_url: user.avatar_url,
      access_token:  result.tokens.access_token,
      refresh_token: result.tokens.refresh_token || '',
      token_type:    result.tokens.token_type || 'Bearer',
      scope:         result.tokens.scope || SCOPES,
      saved_at:      Date.now(),
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
    if (!stored || !stored.access_token) return null;

    log('trySilentVerify — re-hitting /userinfo with stored token');
    try {
      var user = await fetchUserIdentity(stored.access_token);
      var refreshed = Object.assign({}, stored, {
        id:         user.id,
        email:      user.email || stored.email,
        name:       user.name  || stored.name,
        avatar_url: user.avatar_url || stored.avatar_url,
        verified_at: Date.now(),
      });
      persistRecord(refreshed);
      await ensureAvatarFresh(refreshed);
      // Silent re-verification also re-asserts the active-session
      // pointer so a user who launches googleLogin.html directly
      // (without going through the central dashboard) still ends up
      // with `active.json` naming google.
      if (globalThis.__swbAuth) {
        globalThis.__swbAuth.wipeOthers('google');
        globalThis.__swbAuth.setActiveProvider('google');
      }
      return refreshed;
    } catch (e) {
      log('silent verify failed (' + (e && e.message ? e.message : String(e)) + ') — dropping stored record');
      clearStoredRecord();
      return null;
    }
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
