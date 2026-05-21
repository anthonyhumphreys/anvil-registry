---
title: Anvil Node Base
description: Use the hardened Node base image for safer local and CI dependency installs.
section: Concepts
order: 4
---

# Anvil Node Base

Anvil Node Base is a local safety harness. It is not a registry replacement.

Use it for:

- Devcontainers.
- CI containers.
- Agentic coding sandboxes.
- Unknown repo inspection.
- Pull request dependency review.

## Safe mode

```bash
anvil-npm-ci-safe
```

Safe mode runs:

```bash
npm ci --ignore-scripts
```

Then it scans `node_modules` package manifests for lifecycle scripts and writes a report under `.anvil/reports` or `ANVIL_REPORT_DIR`.

## Observed mode

```bash
anvil-npm-ci-observed
```

Observed mode explicitly allows install scripts, wraps the install with syscall monitoring, and writes:

- `npm-install.log`
- `strace.log`
- `lifecycle-scripts.json`
- `ioc-report.json`
- `ioc-report.md`
- `environment-snapshot.json`

Sensitive environment variable values are redacted in the snapshot.

## Registry integration

```bash
anvil-use-registry http://localhost:4873
```

This writes project npm config so scoped and unscoped package traffic routes through Anvil Registry. Scoped registry overrides are removed by default so scoped package installs do not quietly bypass policy.
