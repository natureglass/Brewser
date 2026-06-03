// Dedicated worker source loaded by URL via `new Worker(url)` in the
// Pass D fixture. Demonstrates the URL constructor path works: the
// `loaded-via=` line in the response identifies what loaded it.
self.onmessage = function (e) {
  if (e.data && e.data.cmd === 'whoami') {
    self.postMessage({ source: 'workers-pass-d.js', echo: e.data.echo });
  } else if (e.data && e.data.cmd === 'add') {
    self.postMessage({ result: e.data.a + e.data.b });
  } else {
    self.postMessage({ unknown: e.data });
  }
};
self.postMessage({ ready: true, source: 'workers-pass-d.js' });
