/**
 * Every public hostname must carry the hardening headers.
 *
 * These are static assertions against deploy/Caddyfile rather than a live
 * scan, so that adding a sixth hostname without headers fails here instead of
 * silently shipping. scripts/security-scan.mjs checks the deployed site.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments are stripped everywhere: these assert on configuration, and the
// comment explaining WHY the admin port is not proxied must not be what
// satisfies — or trips — an assertion about the admin port.
const caddyfile = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8")
  .replace(/^\s*#.*$/gm, "");

/** Top-level site blocks, keyed by address. Global block and snippets excluded. */
function sites() {
  const out = {};
  let depth = 0;
  let capturing = null;
  let body = [];
  for (const line of caddyfile.split("\n")) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (depth === 0 && opens > closes) {
      // A block opens at the top level. It is a SITE only if it is addressed:
      // a bare `{` is the global options block and `(name) {` is a snippet.
      const addressed = line.match(/^([a-z0-9*.,\s]+?)\s*\{\s*$/);
      capturing = addressed ? addressed[1].trim() : null;
      body = [];
      depth += opens - closes;
      continue;
    }

    depth += opens - closes;
    if (depth === 0 && capturing !== null) {
      out[capturing] = body.join("\n");
      capturing = null;
    } else if (capturing !== null) {
      body.push(line);
    }
  }
  return out;
}

// Hostnames, not address lines: splitting or joining site blocks is a
// formatting choice and must not fail a security test.
const PUBLIC_HOSTS = [
  "planto3d.in",
  "www.planto3d.in",
  "planto3d.si",
  "api.planto3d.in",
  "s3.planto3d.in",
];

test("every expected public host has a site block", () => {
  const served = Object.keys(sites()).flatMap((a) => a.split(",").map((h) => h.trim()));
  for (const host of PUBLIC_HOSTS) assert.ok(served.includes(host), `no site block for ${host}`);
});

test("caddy serves no hostname the runbook has no DNS record for", () => {
  // An unrecorded hostname cannot be validated, so Caddy retries it forever,
  // spends failed-validation attempts, and fills the log with "obtaining
  // certificate" — which is the one signal the operator checks to confirm
  // certificate state persisted across a redeploy.
  const served = Object.keys(sites()).flatMap((a) => a.split(",").map((h) => h.trim()));
  for (const host of served) {
    assert.ok(PUBLIC_HOSTS.includes(host), `${host} is served but has no DNS record in deploy/README.md`);
  }
});

test("every public host imports the hardening snippet", () => {
  // One snippet, imported everywhere, so a new hostname cannot ship bare.
  for (const [address, body] of Object.entries(sites())) {
    assert.match(body, /import hardened/, `${address} does not import hardened`);
  }
});

test("the hardening snippet sets the headers that matter", () => {
  const snippet = caddyfile.slice(caddyfile.indexOf("(hardened)"));
  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "X-Frame-Options",
    "Permissions-Policy",
    "-Server",
  ]) {
    assert.match(snippet.slice(0, snippet.indexOf("\n}")), new RegExp(header), `missing ${header}`);
  }
});

test("the viewer's CSP forbids eval and inline script", () => {
  // The page holds an API key in localStorage, so XSS here is credential theft.
  const csp = sites()["planto3d.in"].match(/Content-Security-Policy "([^"]+)"/)[1];
  assert.doesNotMatch(csp, /'unsafe-eval'/, "unsafe-eval would re-enable the easiest XSS path");
  const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, "inline script must stay forbidden");
  assert.match(scriptSrc, /'wasm-unsafe-eval'/, "web-ifc needs wasm, and only wasm");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

test("the viewer may only talk to our own API and object store", () => {
  const csp = sites()["planto3d.in"].match(/Content-Security-Policy "([^"]+)"/)[1];
  const connect = csp.match(/connect-src ([^;]+)/)[1];
  assert.deepEqual(
    connect.trim().split(/\s+/).sort(),
    ["'self'", "https://api.planto3d.in", "https://s3.planto3d.in"].sort(),
    "connect-src must not reach a third party",
  );
});

test("API and object-store responses can never execute as documents", () => {
  for (const host of ["api.planto3d.in", "s3.planto3d.in"]) {
    assert.match(sites()[host], /Content-Security-Policy "default-src 'none'/, `${host} needs default-src 'none'`);
  }
});

test("the object store is reverse-proxied to the S3 port only, never the admin port", () => {
  const s3 = sites()["s3.planto3d.in"];
  assert.match(s3, /reverse_proxy garage:3900/);
  assert.doesNotMatch(s3, /3903/, "Garage's admin API must not be exposed");
});

test("the object store allows any origin, because the redirect chain taints it", () => {
  // Counter-intuitive, and verified in Chrome: planto3d.in -> api.planto3d.in
  // -> 302 -> s3.planto3d.in is a redirect whose FIRST hop is already
  // cross-origin, so the request reaches the store with `Origin: null`. An
  // allow-origin of https://planto3d.in fails that check and every artifact
  // download breaks. This test previously pinned the broken value.
  const s3 = sites()["s3.planto3d.in"];
  const acao = s3.match(/Access-Control-Allow-Origin "([^"]+)"/)[1];
  assert.equal(acao, "*");
});

test("the object store never allows credentials alongside the wildcard", () => {
  // This is what makes `*` safe: the presigned signature IS the credential, so
  // a wildcard grants nothing that holding the URL did not. Adding
  // Allow-Credentials would turn it into a real hole, and browsers forbid the
  // combination anyway — fail here rather than discovering it in production.
  const s3 = sites()["s3.planto3d.in"];
  assert.doesNotMatch(s3, /Access-Control-Allow-Credentials/i);
});

test("dotfiles are not served from the web root", () => {
  assert.match(sites()["planto3d.in"], /respond @hidden 404/);
});

test("the object store answers the preflight the browser's PUT requires", () => {
  // A PUT is never a simple request, so the browser sends OPTIONS first.
  // Garage does not answer it; without this the upload form fails with an
  // unexplained CORS error while curl uploads fine.
  const s3 = sites()["s3.planto3d.in"];
  assert.match(s3, /method OPTIONS/);
  assert.match(s3, /Access-Control-Allow-Methods "[^"]*PUT/);
  assert.match(s3, /respond 204/);
});
