# AGENTS.md

## Scope

These instructions apply to the standalone `anvil-site` Next.js documentation and launch site.

The site is part of the Anvil Registry repository, but it has its own package, lockfile, app routes, components, and docs content under this folder.

## Product Posture

This site documents the first public version of a rough alpha release.

Be honest about alpha quality:

- Say when something is early, local-only, operator-focused, or still maturing.
- Do not describe unbuilt features as production-ready.
- Do not hide sharp edges behind glossy copy.
- Keep docs useful for developers trying to run, inspect, or integrate the project today.

## Source Of Truth

Product intent comes from:

- `../docs/anvil-registry-spec.md`
- `../docs/anvil-node-base-spec.md`
- Existing implementation under `../apps`, `../packages`, `../infra`, and `../devcontainer-base`

If the site docs conflict with the specs, prefer the specs unless the implementation clearly proves the specs are stale. If the specs are vague, make the smallest reasonable assumption and state it.

## Documentation Rules

- Put documentation pages in `content/docs`.
- Use Markdown with frontmatter: `title`, `description`, `section`, and `order`.
- Keep the docs extensive enough for alpha users to run the stack, configure clients, understand policy decisions, use the CLI, use Node Base, review reports, seed caches, troubleshoot failures, and understand known alpha limitations.
- Prefer concrete commands and endpoint examples over abstract descriptions.
- Update relevant docs when changing product behaviour.
- Keep security claims grounded in code or specs.
- Deterministic policy is the enforcement authority. LLM review can explain or summarize evidence; it must not be described as the thing that makes a package allowed.
- Lifecycle scripts must be treated as explicit code execution. Safe mode disables them. Observed mode is an intentional opt-in.

## Site Architecture

- App Router pages live in `app`.
- Reusable UI lives in `components`.
- Docs loading/parsing lives in `lib/docs.ts`.
- Shared site copy and nav data live in `lib/site.ts`.
- Static assets live in `public`.

Docs pages are rendered by `app/docs/[slug]/page.tsx` and discovered from `content/docs/*.md`. Keep frontmatter order stable so the sidebar remains readable.

## Design And Copy

- Keep the UI clear, restrained, and readable.
- This is a security/developer tool site, not a confetti cannon.
- Avoid vague launch copy, exaggerated claims, and unsupported maturity language.
- Prefer "alpha", "local stack", "operator workflow", "policy decision", and "report" when those are the real concepts.
- Do not use visible feature explainer text in UI components when navigation or headings can carry the job.

## Validation

Use the smallest useful validation for the change:

```bash
pnpm build
pnpm typecheck
```

Run `pnpm build` before standalone `pnpm typecheck`; this site's TypeScript config depends on generated Next.js route types. Yes, this is a little cursed. No, pretending otherwise will not help.

For local development:

```bash
pnpm install --ignore-scripts
pnpm dev
```

Do not run dependency install scripts unless explicitly approved.

## Vercel Notes

- Treat Vercel Functions as stateless and ephemeral.
- Store secrets in Vercel environment variables, not in git and not in `NEXT_PUBLIC_*`.
- Sync project settings with `vercel pull` or `vercel env pull` when local parity matters.
- Enable Web Analytics and Speed Insights when the deployed site is ready for public traffic.
- Deploy with the Vercel project root set to `anvil-site`.
