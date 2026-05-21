---
title: Introduction
description: What Anvil Registry is, who it is for, and how the pieces fit together.
section: Getting started
order: 1
---

# Introduction

Anvil Registry is an open source dependency safety toolkit for the Node and npm ecosystem.

It has two parts:

- **Anvil Registry** is a drop-in npm registry gateway. It proxies metadata and tarballs, rewrites tarball URLs through the gateway, caches artifacts, evaluates policy, and records decisions before installs reach developers or CI.
- **Anvil Node Base** is a hardened Node devcontainer base image. It defaults npm toward safer installs, supports observed install mode, and writes local security reports for unknown projects.

The goal is practical dependency review. Anvil Registry does not ask teams to stop using npm clients, rewrite package managers, or trust a black box. It puts policy and evidence in the install path.

## Why it exists

Most teams discover dependency risk after the install has already happened. That is backwards.

Anvil Registry moves the decision earlier:

1. Fetch package metadata through a controlled gateway.
2. Evaluate cheap metadata policy immediately.
3. Queue deeper analysis outside the request path.
4. Cache analysis and policy decisions by immutable tarball identity.
5. Return clear block, quarantine, or allow explanations.

## Design principles

- Deterministic policy is the enforcement authority.
- LLM review can explain risk, but it cannot allow a package by itself.
- CI and production should fail closed where it matters.
- Overrides must be explicit, reasoned, audited, and preferably expiring.
- Install scripts should not execute unless someone intentionally opted into them.

## Core components

| Component | Role |
| --- | --- |
| Gateway | npm-compatible metadata and tarball proxy |
| Worker | Static analysis, name-squatting checks, provenance context, LLM review |
| Admin | Human review, decisions, reports, overrides, policy visibility |
| CLI | Explain decisions, scan lockfiles, request analysis, manage overrides |
| Node Base | Safer local and CI container for dependency installation |

## Repository link

Set `NEXT_PUBLIC_GIT_REPO_URL` in Vercel to wire the repository buttons on this site.
