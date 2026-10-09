# Isolated learning capacity harness (candidate)

This harness reuses `docker-compose.learning-test.yml` and the official
`learning:harness:up` / `learning:harness:down` scripts. It runs a synthetic
inbound turn through `ConversationEngineService`, persists the proposed reply,
and calls `AutomatedDeliveryService` with an in-process provider double and a
simulated Meta sender. No external provider or Meta client is constructed.

## Usage

In a clean, non-served worktree, check at least 8 GiB free and at most 85%
usage on `/` before installing dependencies or creating any test resource.
Use the versioned lockfile, then run:

```sh
npm ci --no-audit --no-fund
npm run capacity:learning
```

The default **smoke** profile uses one worker, four synthetic turns and a
10-second enqueue window. It validates instrumentation and cleanup; it is not
a representative load result. Parameters can be explicit:

```sh
npm run capacity:learning -- --concurrency 4 --turns 100 --duration-seconds 60
```

Any override is labelled `custom-unapproved`, never `representative`. The
operator must approve scenario mix, concurrency, volume, duration, limits and
pass/fail thresholds before a representative run. The runner caps concurrency,
turns and duration to protect the VPS.

The runner validates the Compose project, service images, project network,
volume, loopback ports, database/user, mount targets and inherited connection
overrides before starting Docker. It refuses existing project resources and a
non-local Docker host. It passes only a small environment allowlist to the
workload, excluding provider credentials and production flags. On success,
error or SIGINT/SIGTERM, it calls the official `learning:harness:down` and
checks for remaining containers, network and volumes. If cleanup reports any
resource, stop and inspect it before another run.

Output contains only aggregate counts and measurements: completed and
confirmed turns, errors, retries, queue-depth peak, p50/p95 final-delivery
latency, peak host CPU, minimum available RAM/disk and peak swap use. The
synthetic database and queue live only in the isolated project and are removed
by `down --volumes`. Do not attach real contacts, messages, prompts or provider
endpoints.
