// The production topology has invariants worth failing a build over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments stripped from both. These tests assert on configuration, and a
// comment explaining why a directive is absent must not read as the directive
// being present — a mistake made five separate times while writing this file.
const strip = (text) => text.replace(/^\s*#.*$/gm, "");
const compose = strip(readFileSync(new URL("../docker-compose.prod.yml", import.meta.url), "utf8"));
const env = strip(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
// Unstripped, for the one assertion about DOCUMENTATION rather than config:
// the staging URL is deliberately a commented example.
const envRaw = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
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

test("garage has a healthcheck, and the app services wait on it", () => {
  // The original premise — "Garage ships no healthcheck mechanism" — was
  // wrong: the scratch image carries /garage and `garage status` is already
  // used as a readiness probe by provision-garage.sh. The previous version of
  // this test asserted the ABSENCE of a healthcheck and so cemented a design
  // where the api probed the store over public HTTPS instead.
  const garage = serviceBlocks().find((b) => b.trim().startsWith("garage:"));
  assert.ok(garage, "no garage service found");
  assert.match(garage, /healthcheck:/);
  assert.match(garage, /"\/garage", "status"/);
  for (const name of ["api", "worker"]) {
    const block = serviceBlocks().find((b) => b.trim().startsWith(`${name}:`));
    assert.match(block, /garage: \{condition: service_healthy\}/, `${name} must wait for garage to be healthy`);
  }
});

test("no app service probes the object store at boot", () => {
  // S3_ENDPOINT is the public https host, so a boot-time probe needs Caddy
  // already serving a TRUSTED certificate. On Let's Encrypt staging — the
  // runbook's starting state — boto3 rejects it and the service crash-loops.
  for (const name of ["api", "worker"]) {
    const block = serviceBlocks().find((b) => b.trim().startsWith(`${name}:`));
    assert.doesNotMatch(block, /wait_ready/, `${name} must not probe the store before serving`);
  }
});

test("compose supplies the production ACME URL, so an empty value never reaches caddy", () => {
  // `${ACME_CA}` alone passed the empty string through, and Caddy's own
  // {$VAR:default} only falls back when a variable is UNSET. The result was
  // `acme_ca` with no argument: a fatal parse error that took the whole proxy
  // down the moment the operator switched from staging to production.
  assert.match(compose, /ACME_CA: \$\{ACME_CA:-https:\/\/acme-v02\.api\.letsencrypt\.org\/directory\}/);
  assert.doesNotMatch(compose, /ACME_CA: \$\{ACME_CA\}/);
  // And staging must stay documented, since that is the rate-limit protection.
  assert.match(envRaw, /acme-staging-v02/);
});

test("secrets are scoped per service, not handed to everything", () => {
  // `env_file: [.env]` gave the api the worker's LLM key AND Garage's admin
  // token — which it could have carried to garage:3903 on this network to mint
  // keys or delete buckets. Spec §6 says the LLM key is worker-only.
  for (const name of ["api", "worker"]) {
    const block = serviceBlocks().find((b) => b.trim().startsWith(`${name}:`));
    assert.doesNotMatch(block, /env_file/, `${name} must name its variables, not load the whole .env`);
    assert.doesNotMatch(block, /GARAGE_ADMIN_TOKEN/, `${name} has no use for the admin token`);
    assert.doesNotMatch(block, /GARAGE_RPC_SECRET/, `${name} has no use for the RPC secret`);
  }
  const api = serviceBlocks().find((b) => b.trim().startsWith("api:"));
  const worker = serviceBlocks().find((b) => b.trim().startsWith("worker:"));
  for (const key of [/ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(api, key, "the api never calls an LLM (spec §6)");
  }
  assert.match(worker, /OPENAI_API_KEY/, "the worker is the tier that calls the LLM");
});

test("the worker carries a complete LLM configuration", () => {
  // provider 'openai' against a base URL is how archiAgent reaches NVIDIA.
  // Missing any one of these and the first classification fails: no provider
  // means it defaults to anthropic, no base URL means it calls OpenAI with an
  // nvapi- key, and no model means build_client refuses the anthropic default.
  const worker = serviceBlocks().find((b) => b.trim().startsWith("worker:"));
  for (const v of ["ARCHIAGENT_LLM_PROVIDER", "ARCHIAGENT_LLM_BASE_URL", "ARCHIAGENT_LLM_MODEL"]) {
    assert.match(worker, new RegExp(v), `worker must set ${v}`);
    // Literal, not interpolated: compose gives the host shell precedence over
    // .env, so ${...} here means a stray profile export silently changes the
    // deployed model. Observed during setup.
    assert.doesNotMatch(
      worker,
      new RegExp(`${v}: \\$\\{`),
      `${v} must be a literal value, or the host shell can override it`,
    );
  }
  assert.match(worker, /ARCHIAGENT_LLM_MODEL: "moonshotai\/kimi-k3"/);
});

test("a per-call LLM timeout is set, and sits below the conversion timeout", () => {
  // Measured: a two-token completion hung 4h15m against a stalled provider
  // before returning 504, because no timeout was configured. One worker at
  // concurrency 1 means that is the entire service stopped.
  const worker = serviceBlocks().find((b) => b.trim().startsWith("worker:"));
  const llm = Number(worker.match(/ARCHIAGENT_LLM_TIMEOUT: "(\d+)"/)?.[1]);
  assert.ok(llm > 0, "ARCHIAGENT_LLM_TIMEOUT must be set; unset is unbounded in practice");
  const cli = Number(compose.match(/CLI_TIMEOUT_S:-(\d+)/)[1]);
  assert.ok(
    llm < cli,
    `LLM timeout ${llm}s must sit below the CLI timeout ${cli}s, or the process is killed before it can say which provider failed`,
  );
});

test("the queue timeout stays larger than the conversion timeout", () => {
  // Measured: a 79-layer DXF took 31m42s. If RQ kills the job first, the
  // CLI's own timeout never applies and the traceback is never recorded.
  const cli = Number(compose.match(/CLI_TIMEOUT_S:-(\d+)/)[1]);
  const queue = Number(compose.match(/QUEUE_TIMEOUT_S:-(\d+)/)[1]);
  assert.ok(cli >= 3600, `cli timeout ${cli}s must exceed the measured 31m42s`);
  assert.ok(queue > cli, `queue timeout ${queue}s must exceed cli ${cli}s`);
});
