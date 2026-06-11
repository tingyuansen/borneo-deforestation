// Cloudflare Worker entry point.
// Gates EVERY request (HTML, JS, JSON, and the .bin map tiles) behind a single
// shared password using HTTP Basic Auth, then serves the static assets.
//
// run_worker_first=true (in wrangler.jsonc) makes this run before any asset is
// served, so the tiles are protected too.
//
// Set the password as a secret on the Worker:
//   Settings -> Variables and Secrets -> add  SITE_PASSWORD = <your password>
//   (or: npx wrangler secret put SITE_PASSWORD)
//
// Notes:
//  - Any username works; only the password is checked.
//  - Credentials travel over HTTPS, so they are encrypted in transit.

export default {
  async fetch(request, env) {
    const expected = env.SITE_PASSWORD;
    const header = request.headers.get("Authorization") || "";

    let ok = false;
    if (header.startsWith("Basic ") && expected) {
      try {
        const decoded = atob(header.slice(6)); // "username:password"
        const password = decoded.slice(decoded.indexOf(":") + 1);
        ok = timingSafeEqual(password, expected);
      } catch {
        ok = false;
      }
    }

    if (!ok) {
      return new Response("Authentication required.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="borneo-deforestation"' },
      });
    }

    // Authenticated: serve the static asset for this request.
    return env.ASSETS.fetch(request);
  },
};

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
