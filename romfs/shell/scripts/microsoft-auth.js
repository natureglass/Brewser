// Microsoft Identity Platform (Entra ID) OAuth 2.0 Device Authorization
// Grant for Brewser. Page-flow variant: drives shell/microsoftLogin.html.
// Same stage-attribute model as google-auth.js.
//
// Identity model:
//   * Stable unique ID is Microsoft Graph's `id` field (GUID) from
//     `https://graph.microsoft.com/v1.0/me`. Stable per directory
//     identity; survives display-name / email / UPN changes.
//   * `userPrincipalName` is the email-like login (mutable).
//   * `mail` is the primary email when set by the tenant; we fall back
//     to UPN when absent (common on personal Microsoft accounts where
//     UPN is the user's @outlook.com / @hotmail.com address).
//   * `displayName` is the preferred display string.
//
// Tenant: `common` lets both personal Microsoft accounts (@outlook.com
// etc.) AND work/school accounts sign in with the same client. The
// app registration in Entra must check "Allow public client flows" —
// the device-code flow is a public-client grant (no client_secret).
//
// Persistence: `sdmc:/switch/brewser/shell/auth/microsoft-auth.json`.
// Avatar bitmaps: `microsoft-avatar.<ext>` (200 px) + `microsoft-avatar_64x64.<ext>`.
// Note Microsoft's avatar comes from `/me/photo/$value` and is fetched
// WITH the access token (Graph requires auth on every call); the
// 64×64 thumb uses `/me/photos/64x64/$value` (server-side resize).
//
// Diagnostic log: `sdmc:/switch/brewser/logs/microsoft-auth.log`.

(function () {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================
  var TENANT          = 'common';
  var DEVICE_CODE_URL = 'https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/devicecode';
  var TOKEN_URL       = 'https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/token';
  var USER_API_URL    = 'https://graph.microsoft.com/v1.0/me';
  var PHOTO_API_URL   = 'https://graph.microsoft.com/v1.0/me/photo/$value';
  // Graph supports a fixed enum of pre-computed photo sizes. 64×64 is
  // one of them; the API returns the closest larger size if 64×64
  // isn't pre-rendered for this account.
  var PHOTO_64_API_URL = 'https://graph.microsoft.com/v1.0/me/photos/64x64/$value';

  // User.Read covers `/me`. offline_access keeps a refresh_token in the
  // grant so re-launches can refresh without re-prompting. openid /
  // profile / email are OIDC stamps Microsoft still emits even though
  // we read identity via Graph (cheap to include and lets some tenant
  // admin policies accept the request).
  var SCOPES = 'User.Read offline_access openid email profile';

  var AUTH_DIR  = 'sdmc:/switch/brewser/shell/auth/';
  var AUTH_PATH = AUTH_DIR + 'microsoft-auth.json';

  // Avatar bitmap cache (see microsoft download flow below). Every
  // filename is prefixed with `microsoft-` for per-provider isolation.
  var AVATAR_STEM       = 'microsoft-avatar';
  var AVATAR_THUMB_STEM = 'microsoft-avatar_64x64';
  // Microsoft's PHOTO endpoint returns whatever pre-cached size lives
  // in the directory (often ~448×448 JPEG). We don't get a size query
  // for the "main" PHOTO, just the default render.
  var AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  function avatarMainPath(ext)  { return AUTH_DIR + AVATAR_STEM       + '.' + ext; }
  function avatarThumbPath(ext) { return AUTH_DIR + AVATAR_THUMB_STEM + '.' + ext; }

  var LOG_DIR  = 'sdmc:/switch/brewser/logs/';
  var LOG_PATH = LOG_DIR + 'microsoft-auth.log';

  var MAX_POLL_SECONDS = 15 * 60;

  // ============================================================
  // Diagnostic log
  // ============================================================
  var _logBuffer = [];
  // The log file lands on SDMC and gets pasted verbatim into support
  // threads, so token material must never reach the buffer. Response
  // bodies logged via readJsonWithLog carry access_token/refresh_token/
  // id_token; the eyJ pattern also catches bare JWTs (and MSA tokens
  // ride inside the JSON fields). Lengths are kept for debuggability.
  var REDACT_FIELD_RE = /("(?:access_token|refresh_token|id_token|token)"\s*:\s*")([^"]*)(")/g;
  var REDACT_JWT_RE   = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g;
  function redactTokens(line) {
    if (typeof line !== 'string' || !line) return line;
    return line
      .replace(REDACT_FIELD_RE, function (_m, pre, val, post) {
        return pre + '<redacted:' + val.length + 'ch>' + post;
      })
      .replace(REDACT_JWT_RE, function (m) { return '<redacted:jwt:' + m.length + 'ch>'; });
  }
  function log(line) {
    var ts = new Date().toISOString();
    line = redactTokens(line);
    var entry = '[' + ts + '] ' + line;
    _logBuffer.push(entry);
    try { console.debug('[microsoft-auth] ' + line); } catch (_) {}
    flushLog();
  }
  function flushLog() {
    if (_logBuffer.length === 0) return;
    if (typeof Switch === 'undefined' || !Switch) return;
    var chunk = _logBuffer.join('\n') + '\n';
    _logBuffer = [];
    try {
      try { Switch.mkdirSync(LOG_DIR); } catch (_) { /* exists */ }
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
      try { console.debug('[microsoft-auth] log write failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  }
  log('=== microsoft-auth.js loaded ===');

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

  // ============================================================
  // State
  // ============================================================
  var pollCancelToken = null;
  var flowInFlight = false;

  // ============================================================
  // Helpers
  // ============================================================
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function getClientId() {
    if (!body) return '';
    return (body.getAttribute('data-microsoft-client-id') || '').trim();
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
    try {
      body.classList.remove('auth-stage-tick');
      body.classList.add('auth-stage-tick');
    } catch (_) {}
    try {
      if (typeof globalThis.__swbRepaint === 'function') globalThis.__swbRepaint();
    } catch (_) {}
  }

  function setInlineError(msg) {
    if (emailErrorEl) emailErrorEl.textContent = msg;
  }

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
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
      }
    }
    return parts.join('&');
  }

  function trimForLog(s, limit) {
    if (s == null) return '(null)';
    var str = String(s);
    var max = limit || 500;
    return str.length > max ? (str.slice(0, max) + '…[+' + (str.length - max) + ' chars]') : str;
  }

  async function readJsonWithLog(resp, label) {
    var text = '';
    try { text = await resp.text(); } catch (e) {
      log(label + ' .text() threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    log(label + ' status=' + resp.status
      + ' ct=' + (resp.headers && resp.headers.get ? resp.headers.get('content-type') : '?')
      + ' body=' + trimForLog(text));
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {
      log(label + ' JSON.parse threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  // ============================================================
  // Filesystem
  // ============================================================
  function loadStoredRecord() {
    try {
      var raw = Switch.readFileSync(AUTH_PATH);
      if (!raw) return null;
      var parsed = JSON.parse(new TextDecoder().decode(raw));
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
      return parsed;
    } catch (e) {
      log('loadStoredRecord failed: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  function persistRecord(record) {
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
      Switch.writeFileSync(AUTH_PATH, JSON.stringify(record, null, 2));
      log('persisted record id=' + record.id + ' upn=' + record.login);
      return true;
    } catch (e) {
      log('persistRecord failed: ' + (e && e.message ? e.message : String(e)));
      setInlineError('Failed to persist login: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  function clearStoredRecord() {
    try {
      Switch.writeFileSync(AUTH_PATH, '{}');
      log('cleared stored record');
    } catch (e) {
      log('clearStoredRecord failed: ' + (e && e.message ? e.message : String(e)));
    }
    for (var i = 0; i < AVATAR_EXTS.length; i++) {
      var ext = AVATAR_EXTS[i];
      try { Switch.writeFileSync(avatarMainPath(ext),  new Uint8Array(0)); } catch (_) {}
      try { Switch.writeFileSync(avatarThumbPath(ext), new Uint8Array(0)); } catch (_) {}
    }
    // Drop the "one active session" pointer too — login.html keys its
    // logged-in card on `active.json` AND a populated provider record.
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.clearActiveProvider === 'function') {
      globalThis.__swbAuth.clearActiveProvider();
    }
  }

  // ============================================================
  // Avatar download — Microsoft Graph variant. Photos sit behind
  // OAuth, so every fetch needs the Bearer token. Some accounts have
  // no photo (Graph returns 404); treat that as "no avatar, fall
  // through to placeholder" rather than an error.
  // ============================================================
  function avatarFileExistsAt(path) {
    if (!path) return false;
    try {
      var probe = Switch.readFileSync(path);
      return !!(probe && probe.byteLength > 0);
    } catch (_) { return false; }
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

  async function fetchPhotoAtUrl(url, accessToken, pathBuilder) {
    log('fetchPhotoAtUrl GET ' + url);
    var resp;
    try {
      resp = await globalThis.fetch(url, {
        headers: { 'Authorization': 'Bearer ' + accessToken },
      });
    } catch (e) {
      log('photo fetch threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    if (resp.status === 404) {
      log('photo 404 — user has no Graph photo');
      return null;
    }
    if (!resp.ok) {
      log('photo HTTP ' + resp.status);
      return null;
    }
    var ct = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : '';
    var buf;
    try { buf = await resp.arrayBuffer(); } catch (e) {
      log('photo arrayBuffer threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    var ext = extFromContentType(ct) || extFromMagicBytes(buf) || 'jpg';
    var path = pathBuilder(ext);
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
      Switch.writeFileSync(path, buf);
      log('photo wrote ' + buf.byteLength + ' bytes (ct=' + (ct || '?') + ', ext=' + ext + ') to ' + path);
      return { path: path, ext: ext };
    } catch (e) {
      log('photo write threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  async function downloadAvatar(accessToken) {
    if (!accessToken) return null;
    var main = await fetchPhotoAtUrl(PHOTO_API_URL, accessToken, avatarMainPath);
    if (!main) return null;
    var thumb = await fetchPhotoAtUrl(PHOTO_64_API_URL, accessToken, avatarThumbPath);
    return { mainPath: main.path, thumbPath: thumb ? thumb.path : null };
  }

  // Re-download whenever the token changed (new login) or the cached
  // file disappeared. Microsoft photos have no public URL we can hash,
  // so we tag the record with `avatar_downloaded_for_id` — if the user
  // id matches AND the file exists, skip the network. A future photo
  // change won't auto-refresh; the user can log out / back in.
  async function ensureAvatarFresh(record, accessToken) {
    if (!record) return;
    var sameId = record.avatar_downloaded_for_id === record.id;
    var localOk = avatarFileExistsAt(record.avatar_local_path);
    if (sameId && localOk) {
      log('ensureAvatarFresh: cached ' + record.avatar_local_path + ' already matches user id');
      return;
    }
    var prevMain  = record.avatar_local_path || '';
    var prevThumb = record.avatar_local_thumb_path || '';
    var result = await downloadAvatar(accessToken);
    if (!result) {
      // No photo on this account; leave fields empty + mark we tried.
      record.avatar_downloaded_for_id = record.id;
      record.avatar_local_path = '';
      record.avatar_local_thumb_path = '';
      persistRecord(record);
      return;
    }
    if (prevMain && prevMain !== result.mainPath) {
      try { Switch.writeFileSync(prevMain, new Uint8Array(0)); } catch (_) {}
    }
    if (prevThumb && prevThumb !== result.thumbPath) {
      try { Switch.writeFileSync(prevThumb, new Uint8Array(0)); } catch (_) {}
    }
    record.avatar_downloaded_for_id = record.id;
    record.avatar_local_path        = result.mainPath;
    record.avatar_local_thumb_path  = result.thumbPath || '';
    persistRecord(record);
  }

  // ============================================================
  // Microsoft device flow
  // ============================================================
  async function requestDeviceCode(clientId, loginHint) {
    log('POST ' + DEVICE_CODE_URL + ' client_id=' + clientId + ' hint=' + (loginHint || ''));
    var bodyFields = { client_id: clientId, scope: SCOPES };
    if (loginHint) bodyFields.login_hint = loginHint;
    var resp;
    try {
      resp = await globalThis.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: formBody(bodyFields),
      });
    } catch (e) {
      log('devicecode fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Network error: ' + (e && e.message ? e.message : String(e)));
    }
    var data = await readJsonWithLog(resp, 'devicecode');
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
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
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
      if (err === 'authorization_declined') return { error: 'You denied the sign-in request.' };
      if (err === 'expired_token' || err === 'code_expired') return { error: 'The one-time code expired. Reload to retry.' };
      if (err === 'bad_verification_code') return { error: 'The code was rejected. Reload to retry.' };
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
    log('GET ' + USER_API_URL);
    var resp;
    try {
      resp = await globalThis.fetch(USER_API_URL, {
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Accept': 'application/json',
        },
      });
    } catch (e) {
      log('/me fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('Microsoft Graph /me network error: ' + (e && e.message ? e.message : String(e)));
    }
    var user = await readJsonWithLog(resp, '/me');
    if (!resp.ok) {
      throw new Error('Microsoft Graph /me failed: HTTP ' + resp.status);
    }
    if (!user || typeof user.id !== 'string') {
      throw new Error('Microsoft Graph /me response missing id');
    }

    return {
      id:    user.id,
      login: typeof user.userPrincipalName === 'string' ? user.userPrincipalName : '',
      name:  typeof user.displayName === 'string' ? user.displayName : '',
      email: (typeof user.mail === 'string' && user.mail.length > 0)
               ? user.mail
               : (typeof user.userPrincipalName === 'string' ? user.userPrincipalName : ''),
    };
  }

  // ============================================================
  // Flow entry points
  // ============================================================
  function showSuccess(record) {
    captureRefs();
    if (successEmailEl) successEmailEl.textContent = record.email || '(not set)';
    if (successNameEl) {
      var displayName = record.name || '(no display name)';
      var withLogin = record.login && record.login !== record.name
        ? displayName + ' (' + record.login + ')'
        : displayName;
      successNameEl.textContent = withLogin;
    }
    if (successSubEl) successSubEl.textContent = record.id;
    if (successAvatarEl) {
      var localPath = record.avatar_local_path || '';
      if (localPath && avatarFileExistsAt(localPath)) {
        successAvatarEl.src = localPath;
      } else {
        // Microsoft photos aren't public URLs; if no local file we have
        // nothing to show. Clear the src so the box stays empty.
        successAvatarEl.removeAttribute('src');
      }
    }
    setStage('success');
  }

  async function startDeviceFlow(loginHint) {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) {
      showErrorStage('Microsoft OAuth client_id is not configured. Set "microsoftOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    log('startDeviceFlow hint="' + (loginHint || '') + '"');

    captureRefs();
    if (verificationUrlEl) verificationUrlEl.textContent = '';
    if (userCodeEl) userCodeEl.textContent = '…';
    setPollStatus('Requesting one-time code…');
    setStage('device');

    var device;
    try {
      device = await requestDeviceCode(clientId, loginHint);
    } catch (e) {
      log('startDeviceFlow caught: ' + (e && e.message ? e.message : String(e)));
      setStage('email');
      setInlineError(e && e.message ? e.message : String(e));
      return;
    }

    captureRefs();
    var url = device.verification_uri || device.verification_url || 'https://microsoft.com/devicelogin';
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
      clientId,
      device.device_code,
      device.interval,
      device.expires_in,
      myToken
    );

    if (result.cancelled) return;
    if (result.error) { setPollStatus(result.error, 'error'); return; }
    if (!result.tokens) { setPollStatus('Unexpected end of polling.', 'error'); return; }

    setPollStatus('Fetching Microsoft user info…');
    var user;
    try {
      user = await fetchUserIdentity(result.tokens.access_token);
    } catch (e) {
      log('fetchUserIdentity caught: ' + (e && e.message ? e.message : String(e)));
      setPollStatus(e && e.message ? e.message : String(e), 'error');
      return;
    }

    var record = {
      provider: 'microsoft',
      id: user.id,
      login: user.login,
      email: user.email || loginHint || '',
      name: user.name,
      access_token:  result.tokens.access_token,
      refresh_token: result.tokens.refresh_token || '',
      token_type:    result.tokens.token_type || 'Bearer',
      scope:         result.tokens.scope || SCOPES,
      saved_at:      Date.now(),
    };
    if (!persistRecord(record)) return;
    await ensureAvatarFresh(record, result.tokens.access_token);
    // Enforce "one service login at a time" — wipe every OTHER
    // provider's auth artifacts and stamp `active.json` so the central
    // login dashboard + toolbar avatar slot now point at microsoft.
    if (globalThis.__swbAuth) {
      globalThis.__swbAuth.wipeOthers('microsoft');
      globalThis.__swbAuth.setActiveProvider('microsoft');
    }
    showSuccess(record);
  }

  async function trySilentVerify() {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) return null;
    var stored = loadStoredRecord();
    if (!stored || !stored.access_token) return null;

    log('trySilentVerify — re-hitting /me with stored token');
    try {
      var user = await fetchUserIdentity(stored.access_token);
      var refreshed = Object.assign({}, stored, {
        id: user.id,
        login: user.login,
        email: user.email || stored.email,
        name: user.name || stored.name,
        verified_at: Date.now(),
      });
      persistRecord(refreshed);
      await ensureAvatarFresh(refreshed, stored.access_token);
      // Silent re-verification also re-asserts the active-session
      // pointer so a user who launches microsoftLogin.html directly
      // (without going through the central dashboard) still ends up
      // with `active.json` naming microsoft.
      if (globalThis.__swbAuth) {
        globalThis.__swbAuth.wipeOthers('microsoft');
        // Re-assert only — the session is UNCHANGED, so keep the per-user
        // caches (see the google-auth.js silent-verify note). Passing
        // keepUserCaches stops a page visit from wiping a synced My Apps tab.
        globalThis.__swbAuth.setActiveProvider('microsoft', { keepUserCaches: true });
      }
      return refreshed;
    } catch (e) {
      log('silent verify failed (' + (e && e.message ? e.message : String(e)) + ') — dropping stored record');
      clearStoredRecord();
      return null;
    }
  }

  // ============================================================
  // Wiring
  // ============================================================
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
        try {
          await startDeviceFlow(hint);
        } finally {
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
      showErrorStage('Microsoft OAuth client_id is not configured. Set "microsoftOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    try {
      var record = await trySilentVerify();
      if (record && record.id) { showSuccess(record); return; }
    } catch (e) {
      log('hydrate threw: ' + (e && e.message ? e.message : String(e)));
    }
    setStage('email');
  }

  boot();
})();
