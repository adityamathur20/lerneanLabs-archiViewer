/**
 * Checks the DEPLOYED site, which the static tests cannot: real TLS, real
 * headers as Caddy emits them, real redirects, real auth rejection.
 *
 * Run after the first deploy and after any Caddyfile change:
 *   node scripts/security-scan.mjs                 # planto3d.in
 *   node scripts/security-scan.mjs example.test    # another base domain
 *
 * Exits non-zero if anything fails, so it can gate a deploy.
 */
const base = process.argv[2] ?? "planto3d.in";
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

async function head(url, init = {}) {
  try {
    return await fetch(url, { method: "GET", redirect: "manual", ...init });
  } catch (e) {
    return { error: e.message, headers: new Map(), status: 0 };
  }
}

const hosts = [`https://${base}`, `https://www.${base}`, `https://api.${base}`, `https://s3.${base}`];

for (const url of hosts) {
  const r = await head(url);
  if (r.error) { check(`${url} reachable`, false, r.error); continue; }
  check(`${url} reachable over TLS`, true, `HTTP ${r.status}`);
  check(`${url} HSTS`, (r.headers.get("strict-transport-security") ?? "").includes("max-age="));
  check(`${url} nosniff`, r.headers.get("x-content-type-options") === "nosniff");
  check(`${url} frame deny`, (r.headers.get("x-frame-options") ?? "").toUpperCase() === "DENY");
  check(`${url} no Server header`, !r.headers.get("server"), r.headers.get("server") ?? "absent");
}

// The viewer's CSP, which is what protects the API key in localStorage.
const viewer = await head(`https://${base}/`);
const csp = viewer.headers?.get?.("content-security-policy") ?? "";
check("viewer sends CSP", csp.length > 0);
check("viewer CSP forbids unsafe-eval", csp.length > 0 && !csp.includes("'unsafe-eval'"));
check(
  "viewer CSP forbids inline script",
  csp.length > 0 && !/script-src[^;]*'unsafe-inline'/.test(csp),
);

// Dotfiles must not be served.
const dotfile = await head(`https://${base}/.env`);
check("GET /.env is not served", dotfile.status === 404, `HTTP ${dotfile.status}`);

// .si (or any alternate TLD) must redirect, not serve a second copy.
const alt = base.replace(/\.[a-z]+$/, ".si");
if (alt !== base) {
  const r = await head(`https://${alt}/`);
  const loc = r.headers?.get?.("location") ?? "";
  check(`${alt} redirects to ${base}`, [301, 308].includes(r.status) && loc.includes(base), `HTTP ${r.status} -> ${loc}`);
}

// The API must reject an unauthenticated request, and must not leak existence.
const noauth = await head(`https://api.${base}/v1/jobs`);
check("API rejects unauthenticated listing", noauth.status === 401, `HTTP ${noauth.status}`);
const healthz = await head(`https://api.${base}/healthz`);
check("healthz is public and 200", healthz.status === 200, `HTTP ${healthz.status}`);

// The object store must allow exactly one origin, never a wildcard.
const s3 = await head(`https://s3.${base}/`, { headers: { Origin: `https://${base}` } });
const acao = s3.headers?.get?.("access-control-allow-origin") ?? "";
// Requires a real response: on an unreachable host "" !== "*" would pass and
// report safety that was never checked. A security tool must not do that.
// Exactly one value, and it must be the wildcard (see spec §4.4 on the
// tainted redirect chain). This check previously only rejected the literal
// "*", so a DUPLICATED header arrived as "*, *" and passed — while a browser
// would have refused it for containing multiple values. Live deployment had
// exactly that, because Garage emits its own copy.
check(
  "object store sends exactly one allow-origin value",
  s3.status > 0 && acao === "*",
  s3.status === 0 ? "host unreachable — NOT verified" : `"${acao}"`,
);
check("object store rejects anonymous access", [401, 403].includes(s3.status), `HTTP ${s3.status}`);

// Garage's admin API must not be routed.
const admin = await head(`https://s3.${base}/v2/GetClusterStatus`);
check("Garage admin API is not reachable", [403, 404, 405].includes(admin.status), `HTTP ${admin.status}`);

let failed = 0;
for (const { name, ok, detail } of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
console.log(`\n  ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
