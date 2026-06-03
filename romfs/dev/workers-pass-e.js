// Worker source for the Pass E (fetch proxy) fixture. Responds to a
// few commands from the main fixture. The fetch call runs inside the
// worker but the actual HTTPS work happens on the main thread via the
// __nxInternal envelope — see worker-bootstrap.ts.
self.onmessage = async function (e) {
  var c = e.data;
  if (!c || !c.cmd) return;
  if (c.cmd === 'fetch') {
    try {
      var r = await fetch(c.url, c.init || undefined);
      var text = '';
      try { text = await r.text(); } catch (_) {}
      self.postMessage({
        kind: 'fetchResult',
        ok: r.ok,
        status: r.status,
        url: r.url,
        contentType: r.headers.get('content-type'),
        contentLength: r.headers.get('content-length'),
        bodyLen: text.length,
        bodyHead: text.substring(0, 600),
      });
    } catch (err) {
      self.postMessage({
        kind: 'fetchResult',
        ok: false,
        error: (err && err.message) || String(err),
      });
    }
  } else if (c.cmd === 'parallel') {
    // Kick off N fetches in parallel via Promise.all. Reports the
    // result count + the pending-fetches count AFTER resolution so
    // the fixture can verify _pendingFetches doesn't leak.
    try {
      var urls = c.urls || [];
      var results = await Promise.all(urls.map(function (u) {
        return fetch(u).then(function (r) {
          return r.text().then(function (t) {
            return { ok: r.ok, status: r.status, len: t.length };
          });
        }).catch(function (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        });
      }));
      var remaining = (typeof self.__pendingFetchCount === 'function')
        ? self.__pendingFetchCount() : -1;
      self.postMessage({ kind: 'parallelResult', results: results, remaining: remaining });
    } catch (err) {
      self.postMessage({ kind: 'parallelResult', error: (err && err.message) || String(err) });
    }
  } else if (c.cmd === 'mixed') {
    // Start an inflight fetch but ALSO post back a plain ack right away.
    // Used by the fixture to prove internal messages don't surface to
    // user onmessage even when interleaved with normal traffic.
    var p = fetch(c.url).then(function (r) {
      return r.text().then(function (t) {
        self.postMessage({ kind: 'mixedFetchDone', ok: r.ok, len: t.length });
      });
    }).catch(function (err) {
      self.postMessage({ kind: 'mixedFetchDone', ok: false, error: (err && err.message) || String(err) });
    });
    self.postMessage({ kind: 'mixedAck', stage: 'pre-await' });
    await p;
  } else if (c.cmd === 'echo') {
    // Plain round-trip — used during mixed isolation test to confirm
    // the user-message path still works while a fetch is inflight.
    self.postMessage({ kind: 'echo', payload: c.payload });
  }
};
self.postMessage({ ready: true, source: 'workers-pass-e.js' });
