// Cloudflare Pages Functions middleware.
// Gates EVERY request to the site (HTML, JS, JSON, and the .bin map tiles)
// behind a single shared password using HTTP Basic Auth.
//
// Set the password in the Pages project:
//   Settings -> Variables and Secrets -> add  SITE_PASSWORD = <your password>
//
// Notes:
//  - Any username works; only the password is checked.
//  - Credentials travel over HTTPS, so they are encrypted in transit.
//  - The browser shows a native login dialog and remembers it for the session.

export async function onRequest({ request, env, next }) {
  const expected = env.SITE_PASSWORD;
  const header = request.headers.get("Authorization") || "";

  let ok = false;
  if (header.startsWith("Basic ") && expected) {
    try {
      const decoded = atob(header.slice(6));            // "username:password"
      const password = decoded.slice(decoded.indexOf(":") + 1);
      ok = timingSafeEqual(password, expected);
    } catch {
      ok = false;
    }
  }

  if (ok) return next();

  return new Response("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="borneo-deforestation"' },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
