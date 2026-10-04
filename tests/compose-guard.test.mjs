// The production topology has invariants worth failing a build over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../docker-compose.prod.yml", import.meta.url), "utf8");
const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const serviceBlocks = () =>
  compose.slice(compose.indexOf("services:")).split(/\n  (?=[a-z])/).slice(1);

test("only caddy publishes host ports", () => {
  // A "ports:" under any other service exposes Postgres, Redis or the object
  // store to the internet (spec §3).
  for (const block of serviceBlocks()) {
    const name = block.trim().split(":")[0];
    if (name === "caddy") continue;
    assert.ok(!/^\s+ports:/m.test(block), `service ${name} publishes host ports; only caddy may`);
  }
});

test("the S3 endpoint is the public host, never the compose-internal one", () => {
  // Presigned URLs sign the host; signing for garage:3900 breaks every
  // browser download while curl on the box still works (spec §4.3).
  assert.match(env, /ARCHIAGENT_SERVICE_S3_ENDPOINT=https:\/\/s3\.planto3d\.in/);
  assert.doesNotMatch(compose, /S3_ENDPOINT.*garage:3900/);
});

test("caddy's certificate state is a named volume, declared at the top level", () => {
  // /data holds the ACME account key and every issued certificate. Anonymous,
  // and a redeploy re-requests all five certs; Let's Encrypt's duplicate limit
  // then denies TLS for a week.
  assert.match(compose, /^\s+- caddy_data:\/data$/m, "caddy /data must be the named volume caddy_data");
  assert.match(compose, /^\s+- caddy_config:\/config$/m, "caddy /config must be the named volume caddy_config");
  const declared = compose.slice(compose.lastIndexOf("\nvolumes:"));
  for (const name of ["caddy_data", "caddy_config"]) {
    assert.match(declared, new RegExp(`^  ${name}:`, "m"), `${name} must be declared under top-level volumes`);
  }
});

test("no stateful volume is a host bind mount into a temp path", () => {
  // A bind mount under /tmp is wiped by the OS; it would look like a volume
  // and lose certificates and job rows anyway.
  assert.doesNotMatch(compose, /- \/tmp[^:]*:/);
});

test("garage declares no healthcheck it cannot satisfy", () => {
  const garage = serviceBlocks().find((b) => b.trim().startsWith("garage:"));
  assert.ok(garage, "no garage service found");
  assert.ok(!/^\s+healthcheck:/m.test(garage), "garage ships no healthcheck mechanism");
});

test("both app services wait for the store before serving", () => {
  // Scoped per service, not a global count: a comment elsewhere mentioning
  // wait_ready() must not satisfy this.
  for (const name of ["api", "worker"]) {
    const block = serviceBlocks().find((b) => b.trim().startsWith(`${name}:`));
    assert.ok(block, `no ${name} service found`);
    assert.match(block, /command:[\s\S]*wait_ready\(\)/, `${name} must wait_ready before serving`);
  }
});

test("the ACME staging switch is wired through to caddy", () => {
  // Without this, getting DNS wrong twice costs a week of TLS.
  assert.match(compose, /ACME_CA: \$\{ACME_CA\}/);
  assert.match(env, /acme-staging-v02/);
});
