# Anvil Documentation

This folder contains the source product specifications and the repo-level documentation map.

Anvil is currently a rough alpha. The docs should help developers, operators, and contributors understand what works today, what is intentionally conservative, and where they should still use judgement.

## Source Specs

- `anvil-registry-spec.md`: product intent for the npm registry gateway, policy engine, analysis worker, admin surfaces, storage, queueing, and deployment.
- `anvil-node-base-spec.md`: product intent for the hardened Node 22 devcontainer base image and install/report helper scripts.

Treat these as product intent. If implementation and docs drift, either fix the implementation or update the docs with a clear reason.

## Public Docs Site

The public docs live in `anvil-site/content/docs`.

Current coverage includes:

- Introduction and alpha status.
- Quickstart.
- Architecture.
- Registry request flow and configuration.
- Policy model and package decisions.
- CLI usage.
- API/operator reference.
- Registry seeding from lockfiles.
- Node Base safe mode, observed mode, and reports.
- CI usage.
- Deployment.
- Troubleshooting.

Build and typecheck the docs site with:

```bash
pnpm --dir anvil-site build
pnpm --dir anvil-site typecheck
```

## Component Docs

- `README.md`: repo overview, local development, Docker Compose, CLI, policy, smoke tests, Node Base, and deployment.
- `CONTRIBUTING.md`: contribution, security, documentation, and validation rules.
- `SECURITY.md`: vulnerability reporting and security design expectations.
- `apps/cli/README.md`: CLI package installation and command summary.
- `devcontainer-base/README.md`: Node Base helper commands, strict mode, network policy, report submission, and image validation.
- `anvil-site/README.md`: docs site development and deployment notes.

## Documentation Expectations

When product behaviour changes:

- Update the relevant public docs page.
- Update component READMEs when commands, scripts, or environment variables change.
- Keep alpha limitations visible.
- Prefer exact commands and API examples.
- Avoid claims that the current implementation does not enforce.

The docs are part of the product surface. If they lie, the software gets blamed, and honestly, fair enough.
