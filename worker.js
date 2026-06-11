// Cloudflare Worker entry point.
// Gates EVERY request (HTML, JS, JSON, and the .bin map tiles) behind a single
// shared password using HTTP Basic Auth, then serves the static assets.
//
// run_worker_first=true (in wrangler.jsonc) makes this run before any asset is
// served, so the tiles are protected too.
//
// The password is configured by its SHA-256 hash, baked in below, so the gate
// survives redeploys. (Workers Builds wipes dashboard-set secrets on each CI
// deploy, which would otherwise lock everyone out after every push to main.)
//
// To change the password:
//   printf '%s' 'NEWPASS' | shasum -a 256      then update PASSWORD_SHA256 and commit.
// Or set a SITE_PASSWORD secret on the Worker — it takes precedence when present.
//
// Notes:
//  - Any username works; only the password is checked.
//  - Credentials travel over HTTPS, so they are encrypted in transit.
//  - The hash (not the plaintext) lives in this private repo; a strong random
//    password is infeasible to recover from its SHA-256.

const PASSWORD_SHA256 =
  "3ee1774c802d259d72ccf2367776ea847a852d1d076a366d5621c8875fe13f33";

export default {
  async fetch(request, env) {
    const header = request.headers.get("Authorization") || "";

    let ok = false;
    if (header.startsWith("Basic ")) {
      try {
        const decoded = atob(header.slice(6)); // "username:password"
        const password = decoded.slice(decoded.indexOf(":") + 1);
        if (env.SITE_PASSWORD) {
          // Optional override: if a secret happens to be set, use it.
          ok = timingSafeEqual(password, env.SITE_PASSWORD);
        } else {
          ok = timingSafeEqual(await sha256Hex(password), PASSWORD_SHA256);
        }
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

    return env.ASSETS.fetch(request);
  },
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
