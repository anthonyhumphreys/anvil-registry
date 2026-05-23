# Anvil Registry Site

This is the standalone Next.js documentation and launch site for Anvil Registry and Anvil Node Base.

This is the first public version of the site for a rough **alpha** release. Treat the docs as practical product guidance for early operators and contributors, not as a promise that every workflow is polished, final, or production-hardened. Some surfaces are intentionally still sharp. That is alpha software, not a personality defect. Mostly.

## What lives here

- Product and docs pages for Anvil Registry.
- Product and docs pages for Anvil Node Base.
- CLI, CI, deployment, policy, package-decision, report, seeding, API, architecture, and troubleshooting guides.
- Static assets for the public site.

The documentation source is under `content/docs`. Pages are discovered from Markdown frontmatter and rendered through the docs route.

## Local Development

Install dependencies with lifecycle scripts disabled:

```bash
pnpm install --ignore-scripts
```

Run the site:

```bash
pnpm dev
```

Build before publishing or validating generated route types:

```bash
pnpm build
pnpm typecheck
```

Set the public repository link with:

```bash
NEXT_PUBLIC_GIT_REPO_URL=https://github.com/your-org/your-repo
```

## Documentation Coverage

The docs should be broad enough for a new alpha user to understand:

- What Anvil Registry and Anvil Node Base are.
- How to run the local stack.
- How npm-compatible clients route through the gateway.
- How package decisions, policy, quarantine, blocks, and overrides work.
- How to use the CLI.
- How to warm the registry from lockfiles.
- How to use Node Base safe and observed modes.
- How reports are generated and submitted.
- How CI gates should use the registry and report output.
- How to deploy and troubleshoot the stack.
- Which parts are alpha-quality and what is not finished yet.

When adding product behaviour, update the relevant docs page in the same change. Documentation drift is how projects become haunted.

## Vercel

Deploy with the project root set to this folder:

```text
anvil-site
```

Add `NEXT_PUBLIC_GIT_REPO_URL` in Vercel project settings when the public repo is ready.

## Status

Alpha. First version. Suitable for review, local trials, and early integration work. Do not present this as a mature security product without also saying what has and has not been verified.
