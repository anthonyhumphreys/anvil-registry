---
title: Deployment
description: Deploy the docs site to Vercel and the registry stack locally or on AWS.
section: Operations
order: 5
---

# Deployment

This site is intentionally standalone from the registry workspace. Deploy it from the `anvil-site` folder.

## Vercel

Set the project root to:

```text
anvil-site
```

Add this environment variable:

```bash
NEXT_PUBLIC_GIT_REPO_URL=https://github.com/your-org/your-repo
```

The site uses that value for repository CTAs.

## Local registry stack

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

The local stack includes gateway, worker, admin, Postgres, Redis, and MinIO.

## AWS deployment

Run preflight before deploying:

```bash
PUBLIC_BASE_URL=https://npm.example.com pnpm sst:preflight
```

Then run migrations before routing production install traffic:

```bash
pnpm sst:migrate
```

The SST deployment creates Fargate services, Postgres, S3 package cache, SQS analysis queue, and linked secrets for admin and optional LLM review.
