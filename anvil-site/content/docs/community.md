---
title: Open source launch notes
description: How to explain Anvil clearly on social channels without turning it into brochure sludge.
section: Resources
order: 6
---

# Open source launch notes

Anvil should be easy to explain in one sentence:

> Anvil is an open source npm registry gateway and hardened Node base image that inspects dependency risk before install traffic reaches developers or CI.

## Short post

```text
I am opening up Anvil: a secure npm registry gateway plus a hardened Node devcontainer base image.

It proxies npm metadata and tarballs, rewrites tarball URLs through policy, caches analysis by immutable tarball identity, and gives reviewers clear allow, quarantine, block, and override context.

Basically: less blind npm install, more evidence before the package lands.
```

## Discord version

```text
Anvil is a dependency safety toolkit for Node projects.

The registry gateway sits in front of npm and checks package metadata, tarballs, provenance, name-squatting risk, and static analysis before installs. The Node Base image gives you safer npm defaults plus observed install reports for unknown repos.

It is open source and designed to fit normal npm/pnpm/yarn workflows.
```

## What not to claim

- Do not call it a replacement for npm.
- Do not imply LLM review is the enforcement authority.
- Do not claim it prevents every supply-chain attack.
- Do not invent adoption, benchmarks, or production users.

The honest pitch is stronger: Anvil makes dependency install decisions inspectable, auditable, and earlier.
