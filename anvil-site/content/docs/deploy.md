---
title: Deployment
description: Run Anvil Registry locally and prepare the registry stack for AWS.
section: Operations
order: 5
---

# Deployment

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
