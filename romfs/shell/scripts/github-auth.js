// GitHub OAuth 2.0 Device Authorization Grant for Brewser.
// Page-flow variant: drives shell/githubLogin.html. Stage is the body's
// `data-auth-stage` attribute; the page CSS gates which `.auth-stage-*`
// child is visible.
//
// Identity model:
//   * Stable unique ID is GitHub's `id` field (integer) from
//     api.github.com/user — permanent per-account, never changes
//     even if the user renames their account or changes their email.
//   * `login` (username) is shown for display but is mutable.
//   * Email is captured as a friendly display hint while the device
//     flow runs. If GitHub returns a non-null public email via /user
//     we use that; else we hit /user/emails (user:email scope).
//
// No JWT, no JWKS, no client_secret — GitHub's device flow honors
// RFC 8628's public-client model. Trust is the TLS channel to
// github.com. The opaque access_token gets re-verified by re-calling
// /user on each launch.
//
// Persistence: `sdmc:/switch/brewser/shell/auth/github-auth.json`.
// Diagnostic log: `sdmc:/switch/brewser/logs/github-auth.log` — every
// request URL, response status, response body (first ~500 chars), and
// every fetch error line gets appended. Tail this file when debugging
// the device flow.

(function () {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================
  var DEVICE_CODE_URL = 'https://github.com/login/device/code';
  var TOKEN_URL       = 'https://github.com/login/oauth/access_token';
  var USER_API_URL    = 'https://api.github.com/user';
  var EMAILS_API_URL  = 'https://api.github.com/user/emails';

  // read:user gives access to api.github.com/user (the identity);
  // user:email surfaces the primary verified email even when the
  // user's public profile email is hidden.
  var SCOPES = 'read:user user:email';

  var AUTH_DIR    = 'sdmc:/switch/brewser/shell/auth/';
  var AUTH_PATH   = AUTH_DIR + 'github-auth.json';
  // Cached avatar bitmaps, downloaded once per `avatar_url` change.
  // Live next to `github-auth.json` so a single rm of the auth dir
  // clears all login artifacts in one go. Two sizes are saved:
  //   - `avatar.<ext>`         — 200 px (matches our 160 px on-screen
  //                              display with DPR headroom; what the
  //                              login success stage shows)
  //   - `avatar_64x64.<ext>`   — 64 px thumb (future-use for UI lists,
  //                              chrome strip, etc.)
  // Both are fetched directly from GitHub via the `?s=N` query param
  // (server-side resize) — no canvas / decode work on-device.
  // Extension follows the response's actual image type (GitHub serves
  // JPEG today; future-proofed against PNG / GIF / WebP via
  // Content-Type + magic-byte sniff).
  var AVATAR_STEM       = 'avatar';
  var AVATAR_THUMB_STEM = 'avatar_64x64';
  var AVATAR_MAIN_PX    = 200;
  var AVATAR_THUMB_PX   = 64;
  // Extensions we may have ever written under either stem. Used by
  // `clearStoredRecord` + the format-changed path in
  // `ensureAvatarFresh` to wipe stale bitmaps without depending on a
  // directory walk (the runtime exposes no `unlinkSync`; we overwrite
  // with empty bytes instead).
  var AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  function avatarMainPath(ext) { return AUTH_DIR + AVATAR_STEM + '.' + ext; }
  function avatarThumbPath(ext) { return AUTH_DIR + AVATAR_THUMB_STEM + '.' + ext; }

  var LOG_DIR  = 'sdmc:/switch/brewser/logs/';
  var LOG_PATH = LOG_DIR + 'github-auth.log';

  var MAX_POLL_SECONDS = 15 * 60;

  // ============================================================
  // Diagnostic log — appends timestamped lines to LOG_PATH. Capped
  // implicitly by SD card free space; the user can delete the file at
  // any time and it'll re-create on the next launch. Falls back to
  // console.debug when the Switch API isn't available (running this
  // page outside the brewser shell, e.g. in a normal browser tab).
  // ============================================================
  var _logBuffer = [];
  function log(line) {
    var ts = new Date().toISOString();
    var entry = '[' + ts + '] ' + line;
    _logBuffer.push(entry);
    // Mirror to console for live tail.
    try { console.debug('[github-auth] ' + line); } catch (_) {}
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
        // Older runtime — round-trip via read + write.
        var existing = '';
        try {
          var raw = Switch.readFileSync(LOG_PATH);
          if (raw) existing = new TextDecoder().decode(raw);
        } catch (_) { /* missing */ }
        Switch.writeFileSync(LOG_PATH, existing + chunk);
      }
    } catch (e) {
      // Don't let log writes break the auth flow.
      try { console.debug('[github-auth] log write failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  }
  // Boot marker so each new login attempt is easy to find in the log.
  log('=== github-auth.js loaded ===');

  // ============================================================
  // DOM refs — populated by captureRefs()
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
    // Probe what the live-DOM/live-CSS thinks the computed font-size
    // for each focal element is — answers the "is the cascade
    // honoring my class / inline-style font-size?" question without
    // the user having to eyeball the on-screen result.
    function fz(el) {
      if (!el) return '(null)';
      try {
        var s = el.style;
        var inline = s && s.fontSize !== undefined ? s.fontSize : '(undef)';
        // getComputedStyle isn't on LiveElement; we read .style.fontSize
        // (the parsed inline value) and the `style` attribute as a
        // sanity check that the HTML parser fed it through.
        var attr = el.getAttribute ? (el.getAttribute('style') || '') : '';
        var attrFontSize = '(none)';
        var m = /font-size\s*:\s*([^;]+)/i.exec(attr);
        if (m) attrFontSize = m[1].trim();
        return 'inline.fontSize=' + inline + ' attr.font-size=' + attrFontSize;
      } catch (e) { return '(probe threw: ' + (e && e.message ? e.message : String(e)) + ')'; }
    }
    log('captureRefs:'
      + ' hintInput=' + !!hintInput
      + ' submitBtn=' + !!submitBtn
      + ' verificationUrlEl=' + !!verificationUrlEl
      + ' userCodeEl=' + !!userCodeEl
      + ' pollStatusEl=' + !!pollStatusEl
      + ' successEmailEl=' + !!successEmailEl);
    log('captureRefs sizes:'
      + ' urlEl[' + fz(verificationUrlEl) + ']'
      + ' codeEl[' + fz(userCodeEl) + ']'
      + ' subEl[' + fz(successSubEl) + ']');
    return !!(hintInput && submitBtn);
  }

  // ============================================================
  // State
  // ============================================================
  var pollCancelToken = null;
  // Guard against double-dispatch on the Continue button. The brewser
  // engine occasionally fires click twice for one physical A-press —
  // log evidence: two `startDeviceFlow` lines 92 ms apart with two
  // distinct device codes returned, the first one immediately
  // abandoned by the second's pollCancelToken bump. Causes the
  // on-screen user_code to be the SECOND code (correct) while the
  // first burns a wasted GitHub request. Bool flag is enough — the
  // guard is released only when the flow lands on a terminal stage
  // (success / error / email / device-with-poll-running), and a
  // separate `submit-disabled` class drops the button off the visual
  // tap target while in flight. */
  var flowInFlight = false;

  // ============================================================
  // Helpers
  // ============================================================
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function getClientId() {
    if (!body) return '';
    return (body.getAttribute('data-github-client-id') || '').trim();
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
    // setAttribute on a non-class attribute doesn't invalidate the
    // live-overlay body cache the way classList does. Toggle a dummy
    // class so LiveTokenList.notify chains
    // invalidateLiveStyle → bumpLiveTreeVersion → markLiveDirty.
    try {
      body.classList.remove('auth-stage-tick');
      body.classList.add('auth-stage-tick');
    } catch (_) {}
    // Additionally request a full repaint via the shell's global
    // exposed for this purpose (used by download-modal after install
    // finishes to refresh upgrade chips). Belt-and-suspenders to the
    // classList toggle above — without it, previous stages' rendered
    // text (e.g. the success-stage explanation) ghosts behind the
    // freshly-shown stage's content.
    try {
      if (typeof globalThis.__swbRepaint === 'function') {
        globalThis.__swbRepaint();
      }
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

  // Trim a string for log output. Keeps the first ~500 chars so a full
  // JSON response is readable but a massive HTML error page doesn't
  // bloat the log file.
  function trimForLog(s, limit) {
    if (s == null) return '(null)';
    var str = String(s);
    var max = limit || 500;
    return str.length > max ? (str.slice(0, max) + '…[+' + (str.length - max) + ' chars]') : str;
  }

  // Read the response body as text first (for logging), then try to
  // parse as JSON. This is critical — if `resp.json()` throws and we
  // never see the body, we can't tell whether GitHub sent text/html,
  // an unexpected JSON shape, or an empty body.
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
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) { /* exists */ }
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
    try {
      Switch.writeFileSync(AUTH_PATH, '{}');
      log('cleared stored record');
    } catch (e) {
      log('clearStoredRecord failed: ' + (e && e.message ? e.message : String(e)));
    }
    // Drop the cached avatar bitmaps on logout so a re-login that
    // lands on a different account doesn't accidentally show the
    // previous user's face for the first frame. `writeFileSync` of
    // empty bytes is the available "remove" in this runtime —
    // `unlinkSync` isn't exposed; an empty file makes
    // `avatarFileExistsAt` return false. Wipe all known extensions
    // under both stems (main + 64×64 thumb) so a format change between
    // logins doesn't leave a previous bitmap on disk.
    for (var i = 0; i < AVATAR_EXTS.length; i++) {
      var ext = AVATAR_EXTS[i];
      try { Switch.writeFileSync(avatarMainPath(ext), new Uint8Array(0)); } catch (_) {}
      try { Switch.writeFileSync(avatarThumbPath(ext), new Uint8Array(0)); } catch (_) {}
    }
    // Drop the "one active session" pointer too — login.html keys its
    // logged-in card on `active.json` AND a populated provider record,
    // so if we leave the pointer naming github after wiping our record
    // the dashboard ends up in an inconsistent half-state until the
    // next login.
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.clearActiveProvider === 'function') {
      globalThis.__swbAuth.clearActiveProvider();
    }
  }

  // ------------------------------------------------------------------
  // Avatar download — pulls the user's GitHub avatar bitmap once per
  // `avatar_url` change and writes it next to github-auth.json. The
  // saved file is then used as the `<img>` src on the success stage
  // (sdmc:/ goes through `LocalSchemeFetchLoader` → captured native
  // fetch → fast SD-card read) so subsequent shell loads don't re-hit
  // the network for the bitmap.
  //
  // Two sizes are fetched and saved:
  //   - 200 px → `avatar.<ext>`         (login success stage)
  //   - 64 px  → `avatar_64x64.<ext>`   (future-use thumb)
  // GitHub honors `?s=N` to serve the bitmap at the requested size, so
  // both downloads are CDN-side resizes — no on-device decode/encode.
  //
  // The on-disk extension follows the actual response format: GitHub
  // currently serves `image/jpeg` so the file lands as `avatar.jpg`,
  // not `avatar.png`. Future-proof against format changes (WebP, etc.)
  // by reading Content-Type first and falling back to magic-byte
  // sniffing of the response body.
  // ------------------------------------------------------------------
  function avatarFileExistsAt(path) {
    if (!path) return false;
    try {
      var probe = Switch.readFileSync(path);
      return !!(probe && probe.byteLength > 0);
    } catch (_) { return false; }
  }

  // Map a Content-Type like `image/jpeg; charset=binary` to an
  // extension. Returns null when the header is missing or holds a
  // non-image value (some CDNs answer with `application/octet-stream`,
  // which we then resolve by sniffing the body).
  function extFromContentType(ct) {
    if (!ct) return null;
    var lower = String(ct).toLowerCase().split(';')[0].trim();
    if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
    if (lower === 'image/png')  return 'png';
    if (lower === 'image/gif')  return 'gif';
    if (lower === 'image/webp') return 'webp';
    return null;
  }

  // Magic-byte sniffer for the same four formats. Belt-and-suspenders
  // to the Content-Type header for misconfigured CDN responses.
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

  // Fetch a single sized variant of the avatar. `pathBuilder(ext)`
  // produces the on-disk path for the detected extension. Returns
  // `{ path, ext }` on success or `null` on any failure.
  async function fetchAvatarAtSize(url, sizePx, pathBuilder) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var sized = url + sep + 's=' + sizePx;
    log('fetchAvatarAtSize GET ' + sized);
    var resp;
    try {
      resp = await globalThis.fetch(sized);
    } catch (e) {
      log('fetchAvatarAtSize fetch threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    if (!resp.ok) {
      log('fetchAvatarAtSize HTTP ' + resp.status);
      return null;
    }
    var ct = (resp.headers && resp.headers.get) ? resp.headers.get('content-type') : '';
    var buf;
    try {
      buf = await resp.arrayBuffer();
    } catch (e) {
      log('fetchAvatarAtSize arrayBuffer threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    var ext = extFromContentType(ct) || extFromMagicBytes(buf) || 'png';
    var path = pathBuilder(ext);
    try {
      try { Switch.mkdirSync(AUTH_DIR); } catch (_) { /* exists */ }
      Switch.writeFileSync(path, buf);
      log('fetchAvatarAtSize wrote ' + buf.byteLength + ' bytes (ct=' + (ct || '?')
        + ', ext=' + ext + ') to ' + path);
      return { path: path, ext: ext };
    } catch (e) {
      log('fetchAvatarAtSize write threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  // Download both sized variants. Returns `{ mainPath, thumbPath }` if
  // the main download succeeded; thumb is best-effort and may be null.
  // Returns `null` if the main download failed (callers treat the
  // result as "use remote URL"). Caller stamps the record fields and
  // re-persists.
  async function downloadAvatar(url) {
    if (!url) return null;
    var main = await fetchAvatarAtSize(url, AVATAR_MAIN_PX, avatarMainPath);
    if (!main) return null;
    var thumb = await fetchAvatarAtSize(url, AVATAR_THUMB_PX, avatarThumbPath);
    return {
      mainPath:  main.path,
      thumbPath: thumb ? thumb.path : null,
    };
  }

  // Best-effort: re-download the bitmaps when the URL changed since
  // the last successful save, or when the cached files disappeared
  // (user deleted them manually, fresh install, logout). On success,
  // stamps `record.avatar_downloaded_url` + `record.avatar_local_path`
  // (main) + `record.avatar_local_thumb_path` (64×64) and re-persists
  // so the next launch can skip the network. Failure leaves the
  // record alone — `showSuccess` will fall back to the remote URL.
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
    // Format flipped (e.g. user re-uploaded as WebP): wipe previous
    // files so they don't linger next to the freshly-written ones.
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
  // GitHub device flow
  // ============================================================
  async function requestDeviceCode(clientId) {
    log('POST ' + DEVICE_CODE_URL + ' client_id=' + clientId);
    var resp;
    try {
      resp = await globalThis.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        // `Accept: application/json` is REQUIRED — without it GitHub
        // serves form-encoded responses and our JSON parse fails.
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

      var err = data && data.error ? data.error : ('HTTP ' + resp.status);
      if (err === 'authorization_pending') {
        setPollStatus('Waiting for confirmation…');
        continue;
      }
      if (err === 'slow_down') {
        // RFC 8628 §3.5: bump interval by 5 s.
        interval += 5;
        setPollStatus('Slowing down — polling every ' + interval + 's…');
        log('poll slow_down — new interval=' + interval + 's');
        continue;
      }
      if (err === 'access_denied') return { error: 'You denied the login request.' };
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
    log('GET ' + USER_API_URL);
    var resp;
    try {
      resp = await globalThis.fetch(USER_API_URL, {
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (e) {
      log('/user fetch threw: ' + (e && e.message ? e.message : String(e)));
      throw new Error('GitHub /user network error: ' + (e && e.message ? e.message : String(e)));
    }
    var user = await readJsonWithLog(resp, '/user');
    if (!resp.ok) {
      throw new Error('GitHub /user failed: HTTP ' + resp.status);
    }
    if (!user || typeof user.id !== 'number') {
      throw new Error('GitHub /user response missing id');
    }

    var email = typeof user.email === 'string' && user.email.length > 0
      ? user.email
      : '';
    if (!email) {
      log('GET ' + EMAILS_API_URL + ' (public email was null)');
      try {
        var emailsResp = await globalThis.fetch(EMAILS_API_URL, {
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        var emails = await readJsonWithLog(emailsResp, '/user/emails');
        if (emailsResp.ok && Array.isArray(emails)) {
          for (var i = 0; i < emails.length; i++) {
            if (emails[i] && emails[i].primary && emails[i].verified
                && typeof emails[i].email === 'string') {
              email = emails[i].email;
              break;
            }
          }
        }
      } catch (e) {
        log('/user/emails fetch threw: ' + (e && e.message ? e.message : String(e)));
      }
    }

    return {
      id: String(user.id),
      login: typeof user.login === 'string' ? user.login : '',
      name: typeof user.name === 'string' && user.name.length > 0 ? user.name : '',
      email: email,
      avatar_url: typeof user.avatar_url === 'string' ? user.avatar_url : '',
    };
  }

  // ============================================================
  // Flow entry points
  // ============================================================
  function showSuccess(record) {
    captureRefs();
    if (successEmailEl) successEmailEl.textContent = record.email || '(not public)';
    if (successNameEl) {
      var displayName = record.name || '(no display name)';
      var withLogin = record.login ? displayName + ' (@' + record.login + ')' : displayName;
      successNameEl.textContent = withLogin;
    }
    if (successSubEl) successSubEl.textContent = record.id;
    if (successAvatarEl) {
      // Prefer the locally cached bitmap (next to github-auth.json)
      // so the success stage paints from disk instead of re-hitting
      // GitHub's CDN every shell load. `ensureAvatarFresh` writes the
      // file before any caller reaches `showSuccess`, but the cache
      // can be empty on a brand-new install / between formats / after
      // a download failure — fall back to the remote URL with `?s=200`
      // so the avatar is never blank when we have a working URL.
      var localPath = record.avatar_local_path || '';
      if (localPath && avatarFileExistsAt(localPath)) {
        successAvatarEl.src = localPath;
      } else if (record.avatar_url) {
        var sep = record.avatar_url.indexOf('?') >= 0 ? '&' : '?';
        successAvatarEl.src = record.avatar_url + sep + 's=' + AVATAR_MAIN_PX;
      } else {
        successAvatarEl.removeAttribute('src');
      }
    }
    setStage('success');
  }

  async function startDeviceFlow(loginHint) {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) {
      showErrorStage('GitHub OAuth client_id is not configured. Set "githubOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
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
      device = await requestDeviceCode(clientId);
    } catch (e) {
      log('startDeviceFlow caught: ' + (e && e.message ? e.message : String(e)));
      setStage('email');
      setInlineError(e && e.message ? e.message : String(e));
      return;
    }

    // Re-capture after stage flip — some live-DOM elements only
    // materialise after their containing subtree flips from
    // display:none to display:block.
    captureRefs();
    var url = device.verification_uri || device.verification_url || 'https://github.com/login/device';
    log('device response — user_code=' + device.user_code + ' url=' + url);
    if (verificationUrlEl) {
      verificationUrlEl.textContent = url;
      // Anchor element — also set href so the URL is a real link
      // styled by the theme's a-rule. Safe to setAttribute on a div
      // too (no-op visually), so the script doesn't have to branch on
      // element type.
      try { verificationUrlEl.setAttribute('href', url); } catch (_) {}
    } else {
      log('WARN: verificationUrlEl is null at write time');
    }
    if (userCodeEl) userCodeEl.textContent = device.user_code;
    else log('WARN: userCodeEl is null at write time');
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
    if (result.error) {
      setPollStatus(result.error, 'error');
      return;
    }
    if (!result.tokens) {
      setPollStatus('Unexpected end of polling.', 'error');
      return;
    }

    setPollStatus('Fetching GitHub user info…');
    var user;
    try {
      user = await fetchUserIdentity(result.tokens.access_token);
    } catch (e) {
      log('fetchUserIdentity caught: ' + (e && e.message ? e.message : String(e)));
      setPollStatus(e && e.message ? e.message : String(e), 'error');
      return;
    }

    var record = {
      provider: 'github',
      id: user.id,
      login: user.login,
      email: user.email || loginHint || '',
      name: user.name,
      avatar_url: user.avatar_url,
      access_token: result.tokens.access_token,
      token_type: result.tokens.token_type || 'bearer',
      scope: result.tokens.scope || '',
      saved_at: Date.now(),
    };
    if (!persistRecord(record)) return;
    // Best-effort: download both sized variants of the avatar to
    // sdmc:/…/auth/ so the success stage paints from a local file
    // (and so any future page can read the saved bitmap without
    // re-hitting GitHub). Stamps `avatar_local_path` /
    // `avatar_local_thumb_path` on the record and re-persists.
    await ensureAvatarFresh(record);
    // Enforce "one service login at a time" — wipe every OTHER
    // provider's auth artifacts and stamp `active.json` so the central
    // login dashboard + toolbar avatar slot now point at github.
    // Ordered after the avatar download so a failed download doesn't
    // leave the user stranded with nothing on disk.
    if (globalThis.__swbAuth) {
      globalThis.__swbAuth.wipeOthers('github');
      globalThis.__swbAuth.setActiveProvider('github');
    }
    showSuccess(record);
  }

  async function trySilentVerify() {
    var clientId = getClientId();
    if (!isClientIdConfigured(clientId)) return null;
    var stored = loadStoredRecord();
    if (!stored || !stored.access_token) return null;

    log('trySilentVerify — re-hitting /user with stored token');
    try {
      var user = await fetchUserIdentity(stored.access_token);
      var refreshed = Object.assign({}, stored, {
        id: user.id,
        login: user.login,
        email: user.email || stored.email,
        name: user.name || stored.name,
        avatar_url: user.avatar_url || stored.avatar_url,
        verified_at: Date.now(),
      });
      persistRecord(refreshed);
      // Refresh the local bitmap if the URL changed since the last
      // save (or the file disappeared). No-op on the steady-state
      // launch where the URL still matches what we already wrote.
      await ensureAvatarFresh(refreshed);
      // Silent re-verification also re-asserts the active-session
      // pointer so a user who launches githubLogin.html directly
      // (without going through the central dashboard) still ends up
      // with `active.json` naming github.
      if (globalThis.__swbAuth) {
        globalThis.__swbAuth.wipeOthers('github');
        globalThis.__swbAuth.setActiveProvider('github');
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
        if (flowInFlight) {
          log('Continue tap ignored — flow already in flight');
          return;
        }
        flowInFlight = true;
        // Belt-and-suspenders: drop the button off the keyboard-tap
        // path AND set the native `disabled` attribute so a tap that
        // slips past the flag still does nothing.
        try { submitBtn.setAttribute('disabled', ''); } catch (_) {}
        var hint = (hintInput && hintInput.value || '').trim();
        // No email-format validation — input now accepts an email OR
        // a GitHub username (or anything else; it's just a display
        // hint, the real identity comes from GitHub's response).
        setInlineError('');
        try {
          await startDeviceFlow(hint);
        } finally {
          // Release on terminal stage. Successful flow lands on
          // success/error stage; failed device/code lands back on
          // email stage. The user can retry from any of those.
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
      showErrorStage('GitHub OAuth client_id is not configured. Set "githubOAuthClientId" in config.json (current: ' + (clientId || '(empty)') + ').');
      return;
    }
    try {
      var record = await trySilentVerify();
      if (record && record.id) {
        showSuccess(record);
        return;
      }
    } catch (e) {
      log('hydrate threw: ' + (e && e.message ? e.message : String(e)));
    }
    setStage('email');
  }

  boot();
})();
