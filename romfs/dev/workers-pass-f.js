// Worker source for the Pass F (ArrayBuffer transfer) fixture. Each
// command exercises one transfer shape; the worker echoes diagnostics
// back to main so the fixture can assert on detach + bytes + sizes.
self.onmessage = function (e) {
  var c = e.data;
  if (!c || !c.cmd) return;
  if (c.cmd === 'inspect') {
    // Single transferred AB: report its size + first/last byte so main
    // can compare against the bytes it sent. The AB the worker holds
    // here is receiver-owned (via JS_NewArrayBuffer ownership).
    var ab = c.payload;
    var v = new Uint8Array(ab);
    self.postMessage({
      kind: 'inspectResult',
      gotByteLength: ab.byteLength,
      head: v[0],
      tail: v[v.byteLength - 1],
      mid: v[(v.byteLength / 2) | 0],
    });
  } else if (c.cmd === 'inspectMixed') {
    // Mixed: payload has { transferred, copied, label } where only
    // `transferred` was in the transfer list. We report both lengths +
    // first bytes so main can prove the copied one survived intact.
    var t = c.payload.transferred;
    var k = c.payload.copied;
    var tv = new Uint8Array(t);
    var kv = new Uint8Array(k);
    self.postMessage({
      kind: 'inspectMixedResult',
      label: c.payload.label,
      tLen: t.byteLength,
      tHead: tv[0],
      tTail: tv[tv.byteLength - 1],
      kLen: k.byteLength,
      kHead: kv[0],
      kTail: kv[kv.byteLength - 1],
    });
  } else if (c.cmd === 'echoTransfer') {
    // Round-trip: receive a transferred AB, then transfer it BACK to
    // main with first byte flipped. Main proves the bytes + the new
    // sender-side detach behaviour (this worker can't reuse the AB
    // after self.postMessage(..., [ab])).
    var ab2 = c.payload;
    var u = new Uint8Array(ab2);
    if (u.byteLength > 0) u[0] = (u[0] ^ 0xFF) & 0xFF;
    var sentLen = ab2.byteLength;
    self.postMessage({ kind: 'echoBack', payload: ab2, originalLen: sentLen }, [ab2]);
    // After transfer, ab2.byteLength should be 0. Report that as a
    // separate user-message — used to verify detach on the WORKER side too.
    self.postMessage({ kind: 'workerSideDetach', afterLen: ab2.byteLength });
  } else if (c.cmd === 'multi') {
    // Multiple transferred ABs in one postMessage. Report sizes + a
    // bytewise sum of each so main can verify all arrived intact.
    var items = c.payload;
    var summaries = [];
    for (var i = 0; i < items.length; i++) {
      var bi = items[i];
      var u8 = new Uint8Array(bi);
      var sum = 0;
      for (var j = 0; j < u8.length; j++) sum = (sum + u8[j]) & 0xFFFFFF;
      summaries.push({ len: bi.byteLength, head: u8[0], tail: u8[u8.length - 1], sum: sum });
    }
    self.postMessage({ kind: 'multiResult', summaries: summaries });
  }
};
self.postMessage({ ready: true, source: 'workers-pass-f.js' });
