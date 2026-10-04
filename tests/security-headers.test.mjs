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

const PUBLIC_HOSTS = [
  "planto3d.in",
  "www.planto3d.in",
  "planto3d.si, www.planto3d.si",
  "api.planto3d.in",
  "s3.planto3d.in",
];

test("every expected public host has a site block", () => {
  const found = Object.keys(sites());
  for (const host of PUBLIC_HOSTS) assert.ok(found.includes(host), `no site block for ${host}`);
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

test("the object store allows exactly one origin, not a wildcard", () => {
  const s3 = sites()["s3.planto3d.in"];
  const acao = s3.match(/Access-Control-Allow-Origin "([^"]+)"/)[1];
  assert.notEqual(acao, "*", "a wildcard would let any site read artifacts via a leaked presigned URL");
  assert.equal(acao, "{$VIEWER_ORIGIN}");
});

test("dotfiles are not served from the web root", () => {
  assert.match(sites()["planto3d.in"], /respond @hidden 404/);
});
