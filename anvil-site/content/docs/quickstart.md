---
title: Quickstart
description: Run Anvil Registry locally and point npm-compatible clients at the gateway.
section: Getting started
order: 2
---

# Quickstart

This guide gets Anvil Registry running locally, points an npm-compatible client at the gateway, and shows where Anvil Node Base fits when you want a safer install container.

## Start Anvil Registry

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The local stack includes:

- Gateway on port `4873`.
- Admin service on port `3000`.
- Worker process for queued analysis.
- Postgres, Redis, and MinIO for local persistence, queueing, and object storage.

Check that the gateway is alive and ready:

```bash
curl http://localhost:4873/-/health
curl http://localhost:4873/-/ready
```

`/-/health` proves the process can answer HTTP. `/-/ready` checks runtime dependencies such as persistence, object storage, and the analysis queue.

## Route npm through the gateway

```bash
npm config set registry http://localhost:4873
```

Project-level config works too:

```ini
registry=http://localhost:4873
```

For pnpm and yarn, set the registry in the project config or pass it directly during a trial install:

```bash
pnpm add is-number@7.0.0 --config.registry=http://localhost:4873
yarn add is-number@7.0.0 --registry http://localhost:4873 --ignore-scripts
```

The gateway rewrites tarball URLs so package bytes continue through Anvil Registry instead of leaking back to the upstream registry.

## Explain a package

```bash
anvil explain react@latest
```

The explain route resolves dist-tags, evaluates policy, and returns the current decision plus analysis and review context when available.

## Queue analysis

```bash
anvil scan pnpm-lock.yaml --queue-analysis
```

Lockfile warming uses `reason: "lockfile_scan"` so worker output can be traced back to preinstall review rather than request-path enforcement.

## Try Anvil Node Base

Use Node Base when you want the install itself to happen inside a safer container:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/<owner>/anvil-node-base:22 anvil-npm-ci-safe
```

Safe mode runs `npm ci --ignore-scripts`, scans installed package manifests, and writes reports under `.anvil/reports` or `ANVIL_REPORT_DIR`.

Observed mode is explicit:

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace ghcr.io/<owner>/anvil-node-base:22 anvil-npm-ci-observed
```

Use observed mode only when dependency lifecycle scripts must run and you want process, network, filesystem, lifecycle, and environment evidence.
