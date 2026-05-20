#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig } from "@anvil/config";
import { parsePopularPackageIndex, type PopularPackageIndex } from "@anvil/name-squatting";
import type { AnalysisReport, LlmRiskReview, Override, PolicyDecision } from "@anvil/shared";

type ReadTextFile = (path: string) => Promise<string>;

export type CliDependencies = {
  fetch: typeof fetch;
  readFile: ReadTextFile;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
};

export type PackageTarget = {
  packageName: string;
  version: string;
};

export async function run(argv: string[], dependencies: CliDependencies = defaultDependencies()): Promise<number> {
  if (argv[0] === "--") argv = argv.slice(1);
  const [command, ...args] = argv;

  try {
    if (command === "doctor") return await doctor(dependencies);
    if (command === "explain") return await explain(args, dependencies);
    if (command === "scan") return await scan(args, dependencies);
    if (command === "warm") return await warm(args, dependencies);
    if (command === "smoke") return await smoke(args, dependencies);
    if (command === "approve") return await approve(args, dependencies);
    if (command === "revoke") return await revoke(args, dependencies);
    if (command === "llm-review") return await llmReview(args, dependencies);
    if (command === "popular-index" && args[0] === "show") return await popularIndexShow(args.slice(1), dependencies);
    if (command === "popular-index" && args[0] === "upload") return await popularIndexUpload(args.slice(1), dependencies);
    if (command === "node-base" && args[0] === "reports") return await nodeBaseReports(args.slice(1), dependencies);
    if (command === "node-base" && args[0] === "report") return await nodeBaseReport(args.slice(1), dependencies);
    if (command === "policy" && args[0] === "test") return await policyTest(args.slice(1), dependencies);

    dependencies.stdout.write(usage());
    return command ? 1 : 0;
  } catch (error) {
    dependencies.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function parseTarget(target: string): PackageTarget {
  const atIndex = target.startsWith("@") ? target.lastIndexOf("@") : target.indexOf("@");
  if (atIndex <= 0) return { packageName: target, version: "latest" };
  return { packageName: target.slice(0, atIndex), version: target.slice(atIndex + 1) };
}

export async function parseLockfile(path: string, read: ReadTextFile = (filePath) => readFile(filePath, "utf8")): Promise<PackageTarget[]> {
  const content = await read(path);
  if (basename(path) === "package-lock.json") return parsePackageLock(content);
  if (basename(path) === "pnpm-lock.yaml") return parsePnpmLock(content);
  if (basename(path) === "package.json") return parsePackageJson(content);
  throw new Error(`Unsupported file type: ${path}`);
}

function parsePackageLock(content: string): PackageTarget[] {
  const parsed = JSON.parse(content) as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  };
  const targets = new Map<string, PackageTarget>();

  for (const [path, metadata] of Object.entries(parsed.packages ?? {})) {
    if (!path.startsWith("node_modules/") || !metadata.version) continue;
    const packageName = path.slice("node_modules/".length);
    if (packageName.includes("/node_modules/")) continue;
    targets.set(`${packageName}@${metadata.version}`, { packageName, version: metadata.version });
  }

  for (const [packageName, metadata] of Object.entries(parsed.dependencies ?? {})) {
    if (!metadata.version) continue;
    targets.set(`${packageName}@${metadata.version}`, { packageName, version: metadata.version });
  }

  return [...targets.values()].sort(compareTargets);
}

function parsePnpmLock(content: string): PackageTarget[] {
  const targets = new Map<string, PackageTarget>();
  const importersIndex = content.indexOf("\nimporters:");
  const packagesSection = importersIndex >= 0 ? content.slice(0, importersIndex) : content;
  const packageLine = /^\s{2}['"]?(?:\/)?((?:@[^/\s]+\/)?[^@\s:'"]+)@([^:\s('"]+)(?:\([^:\n]+\))?['"]?:\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = packageLine.exec(packagesSection))) {
    const packageName = match[1];
    const version = match[2];
    if (!packageName || !version || version.startsWith("link:") || version.startsWith("file:")) continue;
    targets.set(`${packageName}@${version}`, { packageName, version });
  }

  return [...targets.values()].sort(compareTargets);
}

function parsePackageJson(content: string): PackageTarget[] {
  const parsed = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const targets = new Map<string, PackageTarget>();

  for (const dependencies of [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies, parsed.peerDependencies]) {
    for (const [packageName, versionRange] of Object.entries(dependencies ?? {})) {
      if (versionRange.startsWith("file:") || versionRange.startsWith("link:") || versionRange.startsWith("workspace:")) continue;
      targets.set(packageName, { packageName, version: "latest" });
    }
  }

  return [...targets.values()].sort(compareTargets);
}

async function doctor(dependencies: CliDependencies): Promise<number> {
  const registryUrl = registryBaseUrl(dependencies.env);
  const [health, ready, policy] = await Promise.all([
    requestJson<{ ok: boolean }>(dependencies, `${registryUrl}/-/health`),
    requestJson<{ ok: boolean; upstream: string }>(dependencies, `${registryUrl}/-/ready`),
    requestJson<{ runtimeMode: string }>(dependencies, `${registryUrl}/-/anvil/policy`)
  ]);

  dependencies.stdout.write(`Anvil gateway: ${health.ok && ready.ok ? "ok" : "not ready"}\n`);
  dependencies.stdout.write(`Registry: ${registryUrl}\n`);
  dependencies.stdout.write(`Runtime mode: ${policy.runtimeMode}\n`);
  dependencies.stdout.write(`Upstream: ${ready.upstream}\n`);
  return health.ok && ready.ok ? 0 : 1;
}

async function explain(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil explain package@version");
  const result = await explainTarget(parseTarget(targetArg), dependencies);
  printDecision(result, dependencies);
  return result.decision.action === "block" ? 1 : 0;
}

async function scan(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = firstPositionalArg(args);
  if (!path) throw new Error("Usage: anvil scan package-lock.json|pnpm-lock.yaml [--queue-analysis]");
  const shouldQueueAnalysis = hasFlag(args, "--queue-analysis");
  const targets = await parseLockfile(path, dependencies.readFile);
  const results = await Promise.all(targets.map((target) => explainTarget(target, dependencies)));
  const risky = results.filter((result) => result.decision.action !== "allow");
  const analysisTargets = results
    .filter((result) => result.decision.action !== "allow" || !result.analysisReport)
    .map((result) => ({ packageName: result.packageName, version: result.version }));

  dependencies.stdout.write(`Scanned ${results.length} package versions from ${path}.\n`);
  if (shouldQueueAnalysis) {
    const queued = await enqueueAnalysisTargets(analysisTargets, dependencies, registryBaseUrl(dependencies.env));
    dependencies.stdout.write(`Queued analysis for ${queued} risky or unreviewed package versions from ${path}.\n`);
  }
  if (risky.length === 0) {
    dependencies.stdout.write("No blocked, quarantined, or warned packages found.\n");
    return 0;
  }

  for (const result of risky) printDecision(result, dependencies);
  return risky.some((result) => result.decision.action === "block" || result.decision.action === "quarantine") ? 1 : 0;
}

async function warm(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0];
  if (!path) throw new Error("Usage: anvil warm package-lock.json|pnpm-lock.yaml");
  const targets = await parseLockfile(path, dependencies.readFile);
  const packages = [...new Set(targets.map((target) => target.packageName))].sort();
  const registryUrl = registryBaseUrl(dependencies.env);

  await Promise.all(packages.map((packageName) => requestJson(dependencies, `${registryUrl}/${encodePackagePath(packageName)}`)));
  const queued = await enqueueAnalysisTargets(targets, dependencies, registryUrl);
  dependencies.stdout.write(`Warmed metadata and policy decisions for ${packages.length} packages from ${path}.\n`);
  dependencies.stdout.write(`Queued analysis for ${queued} package versions from ${path}.\n`);
  return 0;
}

async function smoke(args: string[], dependencies: CliDependencies): Promise<number> {
  const packageName = args[0] ?? dependencies.env.ANVIL_SMOKE_PACKAGE ?? "is-number";
  const registryUrl = registryBaseUrl(dependencies.env);
  const adminUrl = dependencies.env.ANVIL_ADMIN_URL?.replace(/\/+$/, "");

  dependencies.stdout.write(`Smoke package: ${packageName}\n`);

  const [health, ready] = await Promise.all([
    requestJson<{ ok: boolean }>(dependencies, `${registryUrl}/-/health`),
    requestJson<{ ok: boolean; checks?: Array<{ component: string; ok: boolean }> }>(dependencies, `${registryUrl}/-/ready`)
  ]);
  if (!health.ok || !ready.ok) throw new Error("Gateway is not healthy and ready.");
  dependencies.stdout.write("Gateway health/readiness: ok\n");

  const metadata = await requestJson<SmokePackageMetadata>(dependencies, `${registryUrl}/${encodePackagePath(packageName)}`);
  const version = metadata["dist-tags"]?.latest;
  if (!version) throw new Error(`Metadata for ${packageName} did not include a latest dist-tag.`);
  const versionMetadata = metadata.versions?.[version];
  const tarballUrl = versionMetadata?.dist?.tarball;
  if (!tarballUrl) throw new Error(`Metadata for ${packageName}@${version} did not include a tarball URL.`);
  if (!isGatewayTarballUrl(tarballUrl, registryUrl)) throw new Error(`Tarball URL was not rewritten through Anvil: ${tarballUrl}`);
  dependencies.stdout.write(`Metadata proxy/rewrite: ok (${packageName}@${version})\n`);

  const tarball = await requestBytes(dependencies, tarballUrl);
  if (tarball.byteLength === 0) throw new Error(`Tarball response for ${packageName}@${version} was empty.`);
  dependencies.stdout.write(`Tarball proxy/cache path: ok (${tarball.byteLength} bytes)\n`);

  if (adminUrl) {
    const adminHealth = await requestJson<{ ok: boolean }>(dependencies, `${adminUrl}/-/health`);
    if (!adminHealth.ok) throw new Error("Admin service health check failed.");
    dependencies.stdout.write("Admin health: ok\n");
  }

  dependencies.stdout.write("Anvil smoke check passed.\n");
  return 0;
}

async function approve(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error('Usage: anvil approve package@version --reason "intentional dependency" [--expires-at 2026-06-20T00:00:00Z]');
  const reason = readFlag(args, "--reason");
  if (!reason) throw new Error("Approval requires --reason.");
  const action = readFlag(args, "--action") as "allow" | "warn" | "quarantine" | "block" | undefined;
  const expiresAt = readFlag(args, "--expires-at");
  const target = parseTarget(targetArg);
  const registryUrl = registryBaseUrl(dependencies.env);

  await requestJson(dependencies, `${registryUrl}/-/anvil/override`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(dependencies.env.ADMIN_TOKEN ? { authorization: `Bearer ${dependencies.env.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({ ...target, reason, action: action ?? "allow", ...(expiresAt ? { expiresAt } : {}) })
  });
  dependencies.stdout.write(`Approved override for ${target.packageName}@${target.version}.\n`);
  return 0;
}

async function revoke(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil revoke package@version [--revoked-by reviewer]");
  const revokedBy = readFlag(args, "--revoked-by") ?? "anvil-cli";
  const target = parseTarget(targetArg);
  const registryUrl = registryBaseUrl(dependencies.env);

  await requestJson(dependencies, `${registryUrl}/-/anvil/override/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(dependencies.env.ADMIN_TOKEN ? { authorization: `Bearer ${dependencies.env.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({ ...target, revokedBy })
  });
  dependencies.stdout.write(`Revoked override for ${target.packageName}@${target.version}.\n`);
  return 0;
}

async function llmReview(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil llm-review package@version [--requested-by reviewer] [--priority high]");
  const target = parseTarget(targetArg);
  const requestedBy = readFlag(args, "--requested-by") ?? "anvil-cli";
  const priority = readFlag(args, "--priority");
  const registryUrl = registryBaseUrl(dependencies.env);
  const result = await requestJson<{ queued: number; jobs: Array<{ packageName: string; version: string }> }>(dependencies, `${registryUrl}/-/anvil/llm-review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(dependencies.env.ADMIN_TOKEN ? { authorization: `Bearer ${dependencies.env.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({ ...target, requestedBy, ...(priority ? { priority } : {}) })
  });

  dependencies.stdout.write(`Queued LLM review for ${target.packageName}@${target.version}.\n`);
  dependencies.stdout.write(`Jobs queued: ${result.queued}\n`);
  return 0;
}

async function popularIndexShow(_args: string[], dependencies: CliDependencies): Promise<number> {
  const adminUrl = adminBaseUrl(dependencies.env);
  const index = await requestJson<PopularPackageIndex>(dependencies, `${adminUrl}/api/popular-package-index`);
  printPopularPackageIndex(index, dependencies);
  return 0;
}

async function popularIndexUpload(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0];
  if (!path) throw new Error("Usage: anvil popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]");
  const generatedAt = readFlag(args, "--generated-at");
  const uploadedBy = readFlag(args, "--uploaded-by") ?? "anvil-cli";
  const index = parsePopularPackageIndex(JSON.parse(await dependencies.readFile(path)) as unknown, path);
  const adminUrl = adminBaseUrl(dependencies.env);
  const result = await requestJson<{ activeKey: string; datedKey: string; index: PopularPackageIndex }>(dependencies, `${adminUrl}/api/popular-package-index`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(dependencies.env.ADMIN_TOKEN ? { authorization: `Bearer ${dependencies.env.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({ ...index, ...(generatedAt ? { generatedAt } : index.generatedAt ? { generatedAt: index.generatedAt } : {}), uploadedBy })
  });

  dependencies.stdout.write(`Uploaded popular package index from ${path}.\n`);
  dependencies.stdout.write(`Active key: ${result.activeKey}\n`);
  dependencies.stdout.write(`Dated key: ${result.datedKey}\n`);
  printPopularPackageIndex(result.index, dependencies);
  return 0;
}

async function policyTest(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0] ?? "package.json";
  const targets = await parseLockfile(path, dependencies.readFile);
  const config = loadConfig(dependencies.env);
  const results = await Promise.all(targets.map((target) => explainTarget(target, dependencies)));
  const risky = results.filter((result) => result.decision.action !== "allow");

  dependencies.stdout.write(`Policy ${config.policy.version} loaded in ${config.RUNTIME_MODE} mode.\n`);
  dependencies.stdout.write(`Tested ${results.length} dependency names from ${path} using latest resolvable versions.\n`);
  dependencies.stdout.write("Use lockfile scan for exact installed versions.\n");

  if (risky.length === 0) {
    dependencies.stdout.write("No blocked, quarantined, or warned dependencies found.\n");
    return 0;
  }

  for (const result of risky) printDecision(result, dependencies);
  return risky.some((result) => result.decision.action === "block" || result.decision.action === "quarantine") ? 1 : 0;
}

async function nodeBaseReports(args: string[], dependencies: CliDependencies): Promise<number> {
  const reportType = readFlag(args, "--type");
  const risk = readFlag(args, "--risk");
  const limit = readFlag(args, "--limit") ?? "20";
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams({ limit });
  if (reportType) params.set("reportType", reportType);
  if (risk) params.set("risk", risk);
  const result = await requestJson<{ reports: NodeBaseReportRecord[] }>(dependencies, `${adminUrl}/api/node-base/reports?${params.toString()}`);
  const reports = result.reports ?? [];

  dependencies.stdout.write(`Node Base reports: ${reports.length}${reportType ? ` (${reportType})` : ""}${risk ? ` risk=${risk}` : ""}\n`);
  if (reports.length === 0) {
    dependencies.stdout.write("No Node Base reports found.\n");
    return 0;
  }

  for (const report of reports) {
    dependencies.stdout.write(formatNodeBaseReportLine(report));
  }

  const risky = reports.some((report) => nodeBaseReportRisk(report).high > 0);
  return risky ? 1 : 0;
}

async function nodeBaseReport(args: string[], dependencies: CliDependencies): Promise<number> {
  const id = args[0];
  if (!id) throw new Error("Usage: anvil node-base report <id>");
  const adminUrl = adminBaseUrl(dependencies.env);
  const result = await requestJson<{ report: NodeBaseReportRecord }>(dependencies, `${adminUrl}/api/node-base/reports/${encodeURIComponent(id)}`);
  printNodeBaseReport(result.report, dependencies);
  return nodeBaseReportRisk(result.report).high > 0 ? 1 : 0;
}

async function explainTarget(target: PackageTarget, dependencies: CliDependencies) {
  const registryUrl = registryBaseUrl(dependencies.env);
  return requestJson<ExplainResult>(dependencies, `${registryUrl}/-/anvil/explain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target)
  });
}

async function enqueueAnalysisTargets(targets: PackageTarget[], dependencies: CliDependencies, registryUrl: string): Promise<number> {
  if (targets.length === 0) return 0;
  const result = await requestJson<{ queued: number }>(dependencies, `${registryUrl}/-/anvil/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(dependencies.env.ADMIN_TOKEN ? { authorization: `Bearer ${dependencies.env.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({ targets, reason: "lockfile_scan", priority: "normal", requestedBy: "anvil-cli" })
  });
  return result.queued ?? targets.length;
}

function printDecision(result: ExplainResult, dependencies: CliDependencies) {
  dependencies.stdout.write(`\nAnvil ${formatAction(result.decision.action)} ${result.packageName}@${result.version}\n`);
  dependencies.stdout.write(`${result.decision.explanation}\n`);
  if (result.decision.reasons.length > 0) {
    dependencies.stdout.write("Reasons:\n");
    for (const reason of result.decision.reasons) dependencies.stdout.write(`- ${reason.message}\n`);
  }
  const suggestedPackages = suggestedPackagesFromDecision(result.decision);
  if (suggestedPackages.length > 0) {
    dependencies.stdout.write("Suggested package:\n");
    for (const packageName of suggestedPackages) dependencies.stdout.write(`- ${packageName}\n`);
  }
  if (result.analysisReport) printAnalysisSummary(result.analysisReport, dependencies);
  if (result.llmRiskReviews?.length) printLlmRiskReviewSummary(result.llmRiskReviews, dependencies);
  if (result.override) {
    dependencies.stdout.write("Active override:\n");
    dependencies.stdout.write(`- ${result.override.action}: ${result.override.reason}\n`);
  }
  if (result.decision.action === "block" || result.decision.action === "quarantine") {
    dependencies.stdout.write(`Override:\n- anvil approve ${result.packageName}@${result.version} --reason "intentional dependency"\n`);
  }
}

function printPopularPackageIndex(index: PopularPackageIndex, dependencies: CliDependencies) {
  dependencies.stdout.write(`Popular package index: ${index.source}\n`);
  dependencies.stdout.write(`Generated: ${index.generatedAt ?? "unknown"}\n`);
  dependencies.stdout.write(`Packages: ${index.popularPackages.length}\n`);
  dependencies.stdout.write(`Known confusions: ${Object.keys(index.knownConfusions).length}\n`);
  for (const record of index.popularPackages.slice(0, 10)) {
    dependencies.stdout.write(`- ${record.name}${record.weeklyDownloads !== undefined ? ` downloads=${record.weeklyDownloads}` : ""}${record.aliases?.length ? ` aliases=${record.aliases.join(",")}` : ""}\n`);
  }
  if (index.popularPackages.length > 10) dependencies.stdout.write(`- ... ${index.popularPackages.length - 10} more packages\n`);
}

function suggestedPackagesFromDecision(decision: PolicyDecision): string[] {
  const suggestions = decision.reasons
    .map((reason) => reason.evidence?.suggestedPackage)
    .filter((packageName): packageName is string => typeof packageName === "string" && packageName.length > 0);
  return [...new Set(suggestions)];
}

function printAnalysisSummary(report: AnalysisReport, dependencies: CliDependencies) {
  dependencies.stdout.write("Analysis:\n");
  dependencies.stdout.write(`- analyser: ${report.analyserVersion}\n`);
  dependencies.stdout.write(`- score: ${report.score}\n`);
  if (report.signals.length > 0) {
    dependencies.stdout.write(`- signals: ${report.signals.map((signal) => signal.code).join(", ")}\n`);
  }
}

function printLlmRiskReviewSummary(reviews: LlmRiskReviewRecord[], dependencies: CliDependencies) {
  const latest = reviews[0];
  if (!latest) return;
  dependencies.stdout.write("LLM review:\n");
  dependencies.stdout.write(`- ${latest.provider}/${latest.model}: ${latest.review.riskLevel} confidence=${latest.review.confidence} recommendation=${latest.review.recommendedAction}\n`);
  dependencies.stdout.write(`- ${latest.review.summary}\n`);
  if (latest.review.suspectedRiskTypes.length > 0) {
    dependencies.stdout.write(`- suspected risks: ${latest.review.suspectedRiskTypes.join(", ")}\n`);
  }
}

function formatNodeBaseReportLine(report: NodeBaseReportRecord) {
  const risk = nodeBaseReportRisk(report);
  const highlights = nodeBaseHighlights(report);
  const project = report.projectName ? ` ${report.projectName}` : "";
  const created = report.createdAt ? ` ${report.createdAt}` : "";
  return `- ${report.id ?? "(no id)"} ${report.reportType}${project}${created} high=${risk.high} medium=${risk.medium}${highlights ? ` ${highlights}` : ""}\n`;
}

function printNodeBaseReport(report: NodeBaseReportRecord, dependencies: CliDependencies) {
  const risk = nodeBaseReportRisk(report);
  const body = isRecord(report.report) ? report.report : {};
  dependencies.stdout.write(`Node Base ${report.reportType} report ${report.id ?? ""}\n`);
  dependencies.stdout.write(`Source: ${report.source}${report.projectName ? ` / ${report.projectName}` : ""}\n`);
  if (report.createdAt) dependencies.stdout.write(`Created: ${report.createdAt}\n`);
  dependencies.stdout.write(`Risk: high=${risk.high} medium=${risk.medium}\n`);
  const highlights = nodeBaseHighlights(report);
  if (highlights) dependencies.stdout.write(`Highlights: ${highlights}\n`);

  const findings = [...arrayField(body.highConfidenceFindings), ...arrayField(body.mediumConfidenceFindings)];
  if (findings.length > 0) {
    dependencies.stdout.write("Findings:\n");
    for (const item of findings.slice(0, 20)) {
      const finding = isRecord(item) ? item : {};
      const location = [finding.source, finding.line].filter(Boolean).join(":");
      dependencies.stdout.write(`- ${finding.code ?? "UNKNOWN"}${location ? ` (${location})` : ""}${finding.evidence ? ` ${finding.evidence}` : ""}\n`);
    }
  }

  const networkSummary = isRecord(body.networkSummary) ? body.networkSummary : undefined;
  const connections = arrayField(networkSummary?.connections);
  if (connections.length > 0) {
    dependencies.stdout.write("Connections:\n");
    for (const item of connections.slice(0, 10)) {
      const connection = isRecord(item) ? item : {};
      const target = [connection.address, connection.port].filter(Boolean).join(":") || "(unknown)";
      dependencies.stdout.write(`- ${target}${connection.family ? ` ${connection.family}` : ""}${connection.line ? ` line ${connection.line}` : ""}\n`);
    }
  }

  const policy = isRecord(body.policy) ? body.policy : undefined;
  const networkPolicy = isRecord(policy?.network) ? policy.network : undefined;
  if (networkPolicy) {
    dependencies.stdout.write("Network policy:\n");
    dependencies.stdout.write(`- allowed ports: ${formatList(networkPolicy.allowedPorts)}\n`);
    dependencies.stdout.write(`- allowed hosts: ${formatList(networkPolicy.allowedHosts)}\n`);
    dependencies.stdout.write(`- blocked hosts: ${formatList(networkPolicy.blockedHosts)}\n`);
    dependencies.stdout.write(`- direct IP severity: ${networkPolicy.directIpSeverity ?? "medium"}\n`);
    dependencies.stdout.write(`- non-standard port severity: ${networkPolicy.nonStandardPortSeverity ?? "medium"}\n`);
  }
}

async function requestJson<T = unknown>(dependencies: CliDependencies, url: string, init?: RequestInit): Promise<T> {
  const response = await dependencies.fetch(url, init);
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : undefined;

  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body ? String(body.error) : response.statusText;
    throw new Error(`Anvil request failed (${response.status}): ${detail}`);
  }

  return body as T;
}

async function requestBytes(dependencies: CliDependencies, url: string): Promise<Uint8Array> {
  const response = await dependencies.fetch(url);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Anvil request failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function registryBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.ANVIL_REGISTRY_URL || env.PUBLIC_BASE_URL || "http://localhost:4873").replace(/\/+$/, "");
}

function adminBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.ANVIL_ADMIN_URL || "http://localhost:3000").replace(/\/+$/, "");
}

type NodeBaseReportRecord = {
  id?: string;
  source: string;
  projectName?: string;
  reportType: string;
  summary?: Record<string, unknown>;
  report: unknown;
  createdAt?: string;
};

type SmokePackageMetadata = {
  name: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string } }>;
};

type ExplainResult = {
  packageName: string;
  version: string;
  decision: PolicyDecision;
  analysisReport?: AnalysisReport;
  llmRiskReviews?: LlmRiskReviewRecord[];
  override?: Override;
};

type LlmRiskReviewRecord = {
  packageName: string;
  version: string;
  provider: string;
  model: string;
  review: LlmRiskReview;
  createdAt?: string;
};

function isGatewayTarballUrl(tarballUrl: string, registryUrl: string): boolean {
  try {
    const tarball = new URL(tarballUrl);
    const registry = new URL(registryUrl);
    return tarball.origin === registry.origin;
  } catch {
    return tarballUrl.startsWith("/");
  }
}

function encodePackagePath(packageName: string): string {
  if (!packageName.startsWith("@")) return encodeURIComponent(packageName);
  const [scope, name] = packageName.split("/");
  return `${encodeURIComponent(scope ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function firstPositionalArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function formatAction(action: PolicyDecision["action"]) {
  if (action === "block") return "blocked";
  if (action === "quarantine") return "quarantined";
  if (action === "warn") return "warned";
  return "allowed";
}

function nodeBaseReportRisk(report: NodeBaseReportRecord) {
  const body = isRecord(report.report) ? report.report : {};
  const summary = report.summary ?? (isRecord(body.summary) ? body.summary : undefined);
  return {
    high: numberValue(summary?.highConfidenceFindings) + numberValue(summary?.high),
    medium: numberValue(summary?.mediumConfidenceFindings) + numberValue(summary?.medium)
  };
}

function nodeBaseHighlights(report: NodeBaseReportRecord) {
  const body = isRecord(report.report) ? report.report : {};
  const summary = report.summary ?? (isRecord(body.summary) ? body.summary : undefined);
  const parts = [
    countPart(summary, "packagesWithLifecycleScripts", "lifecycle scripts"),
    countPart(summary, "packagesWithFindings", "packages with findings"),
    countPart(summary, "executedProcesses", "execs"),
    countPart(summary, "outboundConnections", "connections"),
    countPart(summary, "sensitiveFileAccesses", "sensitive file accesses")
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

function countPart(summary: Record<string, unknown> | undefined, key: string, label: string) {
  const value = summary?.[key];
  return typeof value === "number" ? `${value} ${label}` : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function formatList(value: unknown) {
  const items = arrayField(value).map((item) => String(item));
  return items.length > 0 ? items.join(", ") : "(none)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareTargets(a: PackageTarget, b: PackageTarget) {
  return `${a.packageName}@${a.version}`.localeCompare(`${b.packageName}@${b.version}`);
}

function usage() {
  return `Usage:
  anvil doctor
  anvil explain package@version
  anvil scan package-lock.json [--queue-analysis]
  anvil scan pnpm-lock.yaml [--queue-analysis]
  anvil warm package-lock.json
  anvil smoke [package]
  anvil approve package@version --reason "intentional dependency" [--expires-at 2026-06-20T00:00:00Z]
  anvil revoke package@version [--revoked-by reviewer]
  anvil llm-review package@version [--requested-by reviewer] [--priority high]
  anvil popular-index show
  anvil popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]
  anvil node-base reports [--type dependency|lifecycle|ioc|network] [--risk risky|high|medium] [--limit 20]
  anvil node-base report <id>
  anvil policy test package.json
`;
}

function defaultDependencies(): CliDependencies {
  return {
    fetch,
    readFile: (path) => readFile(path, "utf8"),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
