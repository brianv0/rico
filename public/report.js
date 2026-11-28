// Report uncaught browser errors to the app's own server (POST /api/client-error), so a broken release shows up in the
// Workers Logs instead of only in a user's console. Sends the message, stack and script location; never the page
// address, comment text or any account name. At most 5 distinct reports per page load. Loaded first, as a classic script.
(() => {
  const seen = new Set();
  function report(message, stack, source, line) {
    message = String(message || '').slice(0, 300);
    if (!message || seen.has(message) || seen.size >= 5) return;
    seen.add(message);
    try {
      fetch('/api/client-error', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Rico': '1' },
        body: JSON.stringify({ message, stack: String(stack || '').slice(0, 1500), source: String(source || '').slice(0, 200), line }),
      }).catch(() => {});
    } catch { /* reporting must never break the page */ }
  }
  addEventListener('error', (e) => report(e.message, e.error && e.error.stack, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => { const r = e.reason; report(r && r.message ? r.message : String(r), r && r.stack); });
})();
