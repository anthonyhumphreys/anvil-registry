---
title: Policy model
description: How Anvil decides whether a package should be allowed, warned, quarantined, or blocked.
section: Concepts
order: 3
---

# Policy model

Anvil policy is deterministic. It combines metadata, analysis reports, provenance context, package popularity, and audited overrides into a single decision.

## Decision actions

| Action | Meaning |
| --- | --- |
| `allow` | Install can continue. |
| `warn` | Development can proceed, but reviewers should inspect the signal. |
| `quarantine` | The package is held unless the runtime mode permits it or an override exists. |
| `block` | Install is denied. |

## Signals

Anvil can detect:

- New or changed lifecycle scripts.
- Runtime, optional, peer, and development dependency changes.
- New dependencies in patch versions.
- Repository, license, maintainer, `bin`, and `files` metadata changes.
- Unexpected binaries, executable files, hidden files, unusual paths, and credential-looking files.
- Name-squatting and typo-squatting risk.
- Missing, removed, changed, or mismatched provenance.
- LLM-flagged high-risk review context.

## Immutable cache identity

Policy decisions and analysis reports are cached by:

- Package name.
- Version.
- Tarball integrity or hash.
- Analysis engine version.
- Policy version.

If the tarball or analyser changes, the cached decision no longer silently applies to a different artifact.

## Overrides

Overrides are explicit and audited:

```bash
anvil approve suspicious-pkg@1.2.3 --reason "internal fork, reviewed by security"
```

Package-wide overrides are possible, but version-specific overrides are easier to reason about and safer to expire.
