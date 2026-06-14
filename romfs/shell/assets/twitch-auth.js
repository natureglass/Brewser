// Twitch OAuth 2.0 Device Code Grant for Brewser. Page-flow variant:
// drives shell/twitchLogin.html.
//
// Identity model:
//   * Stable unique ID is Helix's `data[0].id` field (string of digits).
//   * `login` is the all-lowercase Twitch handle (mutable).
//   * `display_name` is the cased version shown on the Twitch profile.
//   * `email` requires the `user:read:email` scope on the access token.
//   * `profile_image_url` is a public CDN URL for the avatar.
//
// The Twitch app registration at https://dev.twitch.tv/console must be
// of type "Application" with the device-code flow enabled (set
// "OAuth Redirect URLs" to `https://localhost` — required but unused).
//
// Helix calls require BOTH `Authorization: Bearer …` AND `Client-Id`
// headers. The Client-Id is the same as the OAuth client_id, but the
// header is mandatory on every API request even though the bearer
// already authorises the call.
//
// Persistence: `sdmc:/switch/brewser/shell/auth/twitch-auth.json`.
// Diagnostic log: `sdmc:/switch/brewser/logs/twitch-auth.log`.

(function () {
  'use strict';

  var DEVICE_CODE_URL = 'https://id.twitch.tv/oauth2/device';
  var TOKEN_URL       = 'https://id.twitch.tv/oauth2/token';
  var USERS_API_URL   = 'https://api.twitch.tv/helix/users';

  // user:read:email gives us `email` on the Helix /users response.
  // Without it the field is omitted (still a successful 200, just an
  // empty email). Twitch device-flow uses `scopes` (plural) as the
  // form-body field name — NOT `scope` like every other provider.
  var SCOPES = 'user:read:email';

  var AUTH_DIR  = 'sdmc:/switch/brewser/shell/auth/';
  var AUTH_PATH = AUTH_DIR + 'twitch-auth.json';

  var AVATAR_STEM       = 'twitch-avatar';
  var AVATAR_THUMB_STEM = 'twitch-avatar_64x64';
  var AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  function avatarMainPath(ext)  { return AUTH_DIR + AVATAR_STEM       + '.' + ext; }
  function avatarThumbPath(ext) { return AUTH_DIR + AVATAR_THUMB_STEM + '.' + ext; }

  var LOG_DIR  = 'sdmc:/switch/brewser/logs/';
  var LOG_PATH = LOG_DIR + 'twitch-auth.log';

  var MAX_POLL_SECONDS = 15 * 60;

  // ============================================================
  // Diagnostic log
  // ============================================================
  var _logBuffer = [];
  function log(line) {
    _logBuffer.push('[' + new Date().toISOString() + '] ' + line);
    try { console.debug('[twitch-auth] ' + line); } catch (_) {}
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
      try { console.debug('[twitch-auth] log write failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  }
  log('=== twitch-auth.js loaded ===');

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
    return !!(submitBtn);
  }

  var pollCancelToken = null;
  var flowInFlight = false;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function getClientId() {
    if (!body) return '';
    return (body.getAttribute('data-twitch-client-id') || '').trim();
  }
  function isClientIdConfigured(cid) {
    if (!cid) return false;
    if (cid.indexOf('REPLACE_ME') === 0) return false;
    return cid.length >= 10;
  }

  function setStage(stage) {
    log('setStage ' + stage);
    if (!body) return;
    body.setAttribute('data-auth-stage', stage);
    try { body.classList.remove('auth-stage-tick'); body.classList.add('auth-stage-tick'); } catch (_) {}
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
      log('persisted record id=' + record.id + ' login=' + record.login);
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
  }

  // ============================================================
  // Avatar download — Twitch's `profile_image_url` is a public CDN
  // path with the rendered size baked into the filename
  // (`…-300x300.png`). We don't get a size query parameter; the URL
  // already comes back at ~300 px. Save as-is for the main bitmap.
  // The 64×64 thumb is generated by rewriting `-300x300` →
  // `-50x50` (or similar) if the URL exposes that pattern; otherwise
  // we save the same payload twice (acceptable — costs ~30 KB once).
  // ============================================================
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
  // Twitch CDN paths embed the rendered size into the filename:
  //   `…/profile_images/<id>/<hash>-300x300.png`
  //   `…/profile_images/<id>/<hash>-50x50.png`
  // Standard sizes are 28×28, 50×50, 70×70, 150×150, 300×300, 600×600.
  // Swap the suffix to ask for a different rendering; falls through to
  // the original URL when no `-NxN` token is present (atypical).
  function withTwitchSize(url, sizePx) {
    if (!url) return url;
    if (!/-\d+x\d+(?=\.[a-z]+(?:\?|$))/i.test(url)) return url;
    return url.replace(/-\d+x\d+(?=\.[a-z]+(?:\?|$))/i, '-' + sizePx + 'x' + sizePx);
  }

  async function fetchAvatarAtUrl(url, pathBuilder) {
    log('fetchAvatarAtUrl GET ' + url);
    var resp;
    try { resp = await globalThis.fetch(url); }
    catch (e) { log('fetch threw: ' + (e && e.message ? e.message : String(e))); return null; }
    if (!resp.ok) { log('HTTP ' + resp.status); return null; }
    var ct = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : '';
    var buf;
    try { buf = await resp.arrayBuffer(); }
    catch (e) { log('arrayBuffer threw: ' + (e && e.message ? e.message : String(e))); return null; }
    var ext = extFromContentType(ct) || extFromMagicBytes(buf) || 'png';
    var path = pathBuilder(ext);
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
      Switch.writeFileSync(path, buf);
      log('wrote ' + buf.byteLength + ' bytes (ct=' + (ct || '?') + ', ext=' + ext + ') to ' + path);
      return { path: path, ext: ext };
    } catch (e) { log('write threw: ' + (e && e.message ? e.message : String(e))); return null; }
  }

  async function downloadAvatar(url) {
    if (!url) return null;
    // Twitch's `profile_image_url` already comes back at ~300×300; use
    // that for the main bitmap. For the thumb, rewrite the URL to
    // request a 50×50 rendering — the closest pre-rendered size
    // Twitch's CDN offers below 70×70.
    var main  = await fetchAvatarAtUrl(url, avatarMainPath);
    if (!main) return null;
    var thumbUrl = withTwitchSize(url, 50);
    var thumb = await fetchAvatarAtUrl(thumbUrl, avatarThumbPath);
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
  // Twitch device flow
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
        // Twitch uses `scopes` (plural) where every other provider uses
        // `scope`. Spec-compliant otherwise.
        body: formBody({ client_id: clientId, scopes: SCOPES }),
      });
    } catch (e) {
      log('device fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Network error: ' + (e && e.message ? e.message : String(e)));
    }
    var data = await readJsonWithLog(resp, 'device');
    if (!resp.ok) {
      var msg = data && (data.message || data.error)
        ? (data.message || data.error)
        : ('HTTP ' + resp.status);
      throw new Error('Device authorization failed: ' + msg);
    }
    if (!data || !data.device_code || !data.user_code) {
      throw new Error('Device authorization returned malformed payload');
    }
    return data;
  }

  async function pollForToken(clientId, deviceCode, intervalSec, expiresInSec, scopes, cancelToken) {
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
            scopes: scopes,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
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

      // Twitch's token endpoint returns either `{message, status}` for
      // user-not-yet-confirmed (status 400 message="authorization_pending")
      // or `{error, status, message}` for terminal failures. Treat
      // any 400 with "authorization_pending" or message containing
      // "pending" as the pending state.
      var msg = (data && (data.message || data.error_description)) || '';
      var lower = String(msg).toLowerCase();
      if (resp.status === 400 && lower.indexOf('pending') !== -1) {
        setPollStatus('Waiting for confirmation…');
        continue;
      }
      if (lower.indexOf('slow') !== -1) {
        interval += 5;
        setPollStatus('Slowing down — polling every ' + interval + 's…');
        log('poll slow_down — new interval=' + interval + 's');
        continue;
      }
      if (lower.indexOf('denied') !== -1) return { error: 'You denied the sign-in request.' };
      if (lower.indexOf('expired') !== -1) return { error: 'The one-time code expired. Reload to retry.' };
      log('poll terminal error: ' + msg);
      return { error: 'OAuth error: ' + (msg || 'HTTP ' + resp.status) };
    }
    log('poll deadline reached');
    return { error: 'Authentication timed out. Reload to retry.' };
  }

  // ============================================================
  // Identity fetch
  // ============================================================
  async function fetchUserIdentity(accessToken, clientId) {
    log('GET ' + USERS_API_URL);
    var resp;
    try {
      // Helix requires BOTH headers — Bearer auth + Client-Id.
      resp = await globalThis.fetch(USERS_API_URL, {
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Client-Id':     clientId,
          'Accept':        'application/json',
        },
      });
    } catch (e) {
      log('/users fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Twitch Helix /users network error: ' + (e && e.message ? e.message : String(e)));
    }
    var payload = await readJsonWithLog(resp, '/users');
    if (!resp.ok) throw new Error('Twitch Helix /users failed: HTTP ' + resp.status);
    var user = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!user || typeof user.id !== 'string') throw new Error('Twitch Helix /users response missing data[0].id');

    return {
      id:         user.id,
      login:      typeof user.login        === 'string' ? user.login        : '',
      name:       typeof user.display_name === 'string' ? user.display_name : '',
      email:      typeof user.email        === 'string' ? user.email        : '',
      avatar_url: typeof user.profile_image_url === 'string' ? user.profile_image_url : '',
    };
  }

  // ============================================================
  // Flow entry points
  // ============================================================
  function showSuccess(record) {
    captureRefs();
    if (successEmailEl) successEmailEl.textContent = record.email || '(not granted)';
    if (successNameEl) {
      var displayName = record.name || '(no display name)';
      var withLogin = record.login ? displayName + ' (@' + record.login + ')' : displayName;
      successNameEl.textContent = withLogin;
    }
    if (successSubEl) successSubEl.textContent = record.id;
    if (successAvatarEl) {
      var localPath = record.avatar_local_path || '';
      if (localPath && avatarFileExistsAt(localPath)) {
        successAvatarEl.src = localPath;
      } else if (record.avatar_url) {
        successAvatarEl.src = record.avatar_url;
      } else {
        successAvatarEl.removeAttribute('src');
      }
    }
    setStage('success');
  }

  async function startDeviceFlow(/* loginHint ignored — Twitch has no hint slot */) {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) {
      showErrorStage('Twitch OAuth client_id is not configured. Set "twitchOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    log('startDeviceFlow');

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
    var url = device.verification_uri || device.verification_url || 'https://www.twitch.tv/activate';
    log('device response — user_code=' + device.user_code + ' url=' + url);
    if (verificationUrlEl) {
      verificationUrlEl.textContent = url;
      try { verificationUrlEl.setAttribute('href', url); } catch (_) {}
    }
    if (userCodeEl) userCodeEl.textContent = device.user_code;
    setPollStatus('Waiting for confirmation…');

    var myToken = {};
    pollCancelToken = myToken;
    var result = await pollForToken(
      clientId, device.device_code, device.interval, device.expires_in, SCOPES, myToken,
    );

    if (result.cancelled) return;
    if (result.error)    { setPollStatus(result.error, 'error'); return; }
    if (!result.tokens)  { setPollStatus('Unexpected end of polling.', 'error'); return; }

    setPollStatus('Fetching Twitch user info…');
    var user;
    try { user = await fetchUserIdentity(result.tokens.access_token, clientId); }
    catch (e) {
      log('fetchUserIdentity caught: ' + (e && e.message ? e.message : String(e)));
      setPollStatus(e && e.message ? e.message : String(e), 'error');
      return;
    }

    var record = {
      provider: 'twitch',
      id: user.id,
      login: user.login,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      access_token:  result.tokens.access_token,
      refresh_token: result.tokens.refresh_token || '',
      token_type:    result.tokens.token_type || 'Bearer',
      scope:         Array.isArray(result.tokens.scope) ? result.tokens.scope.join(' ') : (result.tokens.scope || SCOPES),
      saved_at:      Date.now(),
    };
    if (!persistRecord(record)) return;
    await ensureAvatarFresh(record);
    showSuccess(record);
  }

  async function trySilentVerify() {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) return null;
    var stored = loadStoredRecord();
    if (!stored || !stored.access_token) return null;

    log('trySilentVerify — re-hitting /users with stored token');
    try {
      var user = await fetchUserIdentity(stored.access_token, clientId);
      var refreshed = Object.assign({}, stored, {
        id:         user.id,
        login:      user.login,
        email:      user.email || stored.email,
        name:       user.name  || stored.name,
        avatar_url: user.avatar_url || stored.avatar_url,
        verified_at: Date.now(),
      });
      persistRecord(refreshed);
      await ensureAvatarFresh(refreshed);
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
        setInlineError('');
        try { await startDeviceFlow(); }
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
      showErrorStage('Twitch OAuth client_id is not configured. Set "twitchOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
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
