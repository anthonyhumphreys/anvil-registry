---
title: Quickstart
description: Run Anvil Registry locally and point npm-compatible clients at the gateway.
section: Getting started
order: 2
---

# Quickstart

Start the local stack:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The gateway listens on port `4873` by default.

```bash
npm config set registry http://localhost:4873
```

Project-level config works too:

```ini
registry=http://localhost:4873
```

## Check readiness

```bash
curl http://localhost:4873/-/health
curl http://localhost:4873/-/ready
```

`/-/health` proves the process can answer HTTP. `/-/ready` verifies runtime dependencies such as persistence, object storage, and the queue.

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
