import {
  BookOpen,
  Boxes,
  CircleCheck,
  ClipboardCheck,
  Code2,
  Database,
  FileWarning,
  GitBranch,
  Hammer,
  LockKeyhole,
  Network,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow
} from "lucide-react";

export const repositoryUrl = process.env.NEXT_PUBLIC_GIT_REPO_URL || "#";

export const navItems = [
  { label: "Product", href: "/#product" },
  { label: "Docs", href: "/docs/introduction" },
  { label: "Architecture", href: "/#architecture" },
  { label: "Deploy", href: "/#deploy" }
];

export const productCards = [
  {
    title: "Anvil Registry",
    description: "A drop-in npm registry gateway that evaluates packages before install traffic reaches developers or CI.",
    icon: PackageCheck,
    points: ["Policy decisions before tarballs", "Metadata and tarball proxying", "Analysis cached by immutable identity", "Clear block and quarantine reasons"],
    command: "npm config set registry http://localhost:4873"
  },
  {
    title: "Anvil Node Base",
    description: "A hardened Node devcontainer base image for safer installs when you need to inspect unknown repos.",
    icon: Boxes,
    points: ["Non-root by default", "ignore-scripts safe mode", "Observed install mode with reports", "Strict mode for high-confidence IOCs"],
    command: "FROM ghcr.io/<owner>/anvil-node-base:22"
  }
];

export const featureGroups = [
  {
    title: "Deterministic policy",
    description: "Package age, provenance, low adoption, static findings, typo-squatting, and overrides feed one auditable decision.",
    icon: ShieldCheck
  },
  {
    title: "Static package analysis",
    description: "Manifest diffs, lifecycle scripts, dependency shifts, binary files, encoded blobs, and install-path code patterns.",
    icon: FileWarning
  },
  {
    title: "Reviewer context",
    description: "Optional LLM review adds structured risk context without becoming the authority that allows a package.",
    icon: Sparkles
  },
  {
    title: "Install-path telemetry",
    description: "Node Base can capture lifecycle scripts, process execution, network activity, and sensitive file access.",
    icon: Network
  }
];

export const architectureNodes = [
  { label: "Developer / CI", icon: Terminal, details: ["npm", "pnpm", "yarn", "build agents"] },
  { label: "Anvil Registry", icon: Hammer, details: ["policy engine", "analysis queue", "tarball cache", "audit log"] },
  { label: "Upstream npm", icon: GitBranch, details: ["metadata", "tarballs", "audit APIs"] },
  { label: "Data store", icon: Database, details: ["decisions", "reports", "overrides"] }
];

export const docsHighlights = [
  { label: "Quickstart", href: "/docs/quickstart", icon: BookOpen },
  { label: "Policy model", href: "/docs/policy", icon: ClipboardCheck },
  { label: "Node Base", href: "/docs/node-base", icon: LockKeyhole },
  { label: "Deploy", href: "/docs/deploy", icon: Workflow }
];

export const decisionTimeline = [
  { status: "allow", title: "Metadata fetched", detail: "Package metadata is cached and normalized." },
  { status: "review", title: "Static analysis queued", detail: "Unknown tarball identity gets a worker job." },
  { status: "block", title: "Policy signal found", detail: "Lifecycle script changed in a patch release." },
  { status: "allow", title: "Audited override", detail: "Reviewer approves with reason and expiry." }
];

export const deployCards = [
  { title: "Docker Compose", description: "Local gateway, worker, admin, Postgres, Redis, and MinIO.", command: "docker compose -f infra/docker/docker-compose.yml up --build", icon: Boxes },
  { title: "Vercel docs site", description: "This standalone Next.js site deploys cleanly from its own folder.", command: "vercel --cwd anvil-site", icon: CircleCheck },
  { title: "AWS via SST", description: "Fargate services, Postgres, S3, and SQS behind explicit preflight checks.", command: "PUBLIC_BASE_URL=https://npm.example.com pnpm sst:preflight", icon: Workflow },
  { title: "Node Base image", description: "Publish a hardened devcontainer image for CI and repo inspection.", command: "ghcr.io/<owner>/anvil-node-base:22", icon: LockKeyhole }
];

export const launchCopy = [
  "Open source and meant to be inspected.",
  "Works with npm-compatible clients instead of replacing developer workflows.",
  "Optimized for practical review in pull requests, CI, and local repo triage.",
  "Built for the uncomfortable bit between 'npm install' and 'hope nothing weird happened'."
];

export const codeTabs = [
  {
    label: "Analyze",
    command: "$ anvil explain left-pad@1.3.0",
    output: ["Decision: allow", "Policy: default@2026-05", "Provenance: verified", "Signals: no high-confidence findings", "Cache identity: sha512-Qw8...Yjm"]
  },
  {
    label: "Safe install",
    command: "$ anvil-npm-ci-safe",
    output: ["npm ci --ignore-scripts", "Lifecycle report written", "Strict mode: pass"]
  },
  {
    label: "Observed",
    command: "$ anvil-npm-ci-observed",
    output: ["Scripts enabled under strace", "IOC report written", "Sensitive file access: none"]
  }
];

export type IconType = typeof Hammer;
