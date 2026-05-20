import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { AnvilConfig } from "@anvil/config";
import { loadConfig } from "@anvil/config";
import { detectNameSquatting } from "@anvil/name-squatting";
import {
  calculatePackageAgeDays,
  decodeRoutePackageName,
  type DownloadStatsClient,
  NpmDownloadsClient,
  NpmRegistryClient,
  resolveVersionFromTarballName,
  rewriteMetadataTarballs,
  filterMetadataVersions,
  toVersionMetadata,
  type NpmPackageMetadata
} from "@anvil/npm-registry";
import { createObjectStore, type ObjectStore } from "@anvil/object-store";
import { createPersistence, type AnvilPersistence } from "@anvil/persistence";
import { evaluatePolicy } from "@anvil/policy-engine";
import { createJobQueue, type JobQueue } from "@anvil/queue";
import { buildAnvilError, buildPolicyDecisionAuditEvent, isDecisionBlockingInstall, type AnalysisJob, type PolicyDecision } from "@anvil/shared";

const metadataPolicyAnalyserVersion = "metadata-policy-2026-05-20.1";
type ReadinessComponent = "persistence" | "objectStore" | "queue";
const analysisReasons = new Set<AnalysisJob["reason"]>(["metadata_request", "tarball_request", "lockfile_scan", "manual_review"]);
const analysisPriorities = new Set<AnalysisJob["priority"]>(["low", "normal", "high"]);

export type GatewayDependencies = {
  config?: AnvilConfig;
  persistence?: AnvilPersistence;
  objectStore?: ObjectStore;
  queue?: JobQueue;
  registry?: Pick<NpmRegistryClient, "fetchMetadata" | "fetchTarball">;
  downloadStats?: DownloadStatsClient;
};

export function buildGateway(dependencies: GatewayDependencies = {}): FastifyInstance {
  const config = dependencies.config ?? loadConfig();
  const persistence = dependencies.persistence ?? createPersistence(config);
  const objectStore = dependencies.objectStore ?? createObjectStore(config);
  const queue = dependencies.queue ?? createJobQueue(config);
  const registry =
    dependencies.registry ??
    new NpmRegistryClient({
      name: "npmjs",
      baseUrl: config.UPSTREAM_NPM_REGISTRY
    });
  const downloadStats = dependencies.downloadStats ?? new NpmDownloadsClient({ baseUrl: config.NPM_DOWNLOADS_API });

  const app = Fastify({ logger: { name: "anvil-gateway" } });

  app.get("/-/health", async () => ({ ok: true, service: "anvil-gateway" }));
  app.get("/-/ready", async (_request, reply) => {
    const checks = await readinessChecks();
    const ok = checks.every((check) => check.ok);
    if (!ok) return reply.code(503).send({ ok, upstream: config.UPSTREAM_NPM_REGISTRY, checks });
    return { ok, upstream: config.UPSTREAM_NPM_REGISTRY, checks };
  });
  app.get("/-/anvil/policy", async () => ({ runtimeMode: config.RUNTIME_MODE, policy: config.policy }));

  app.post<{
    Body: {
      packageName?: string;
      version?: string;
      targets?: Array<{ packageName?: string; version?: string }>;
      reason?: AnalysisJob["reason"];
      priority?: AnalysisJob["priority"];
      requestedBy?: string;
    };
  }>("/-/anvil/analyze", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    const body = request.body ?? {};
    const targets = analysisTargetsFromBody(body);
    if (targets.length === 0) return reply.code(400).send({ error: "ANVIL_ANALYZE_REQUIRES_TARGETS" });

    const reason = body.reason && analysisReasons.has(body.reason) ? body.reason : "manual_review";
    const priority = body.priority && analysisPriorities.has(body.priority) ? body.priority : "normal";
    const createdAt = new Date().toISOString();
    const jobs = targets.map((target) => ({
      packageName: target.packageName,
      version: target.version,
      requestedBy: body.requestedBy ?? "anvil-gateway",
      reason,
      priority,
      createdAt
    }));

    await Promise.all(jobs.map((job) => queue.enqueueAnalysisJob(job)));
    await Promise.all(
      jobs.map((job) =>
        persistence.putAuditEvent({
          actor: job.requestedBy,
          eventType: "analysis.enqueued",
          targetType: "package",
          targetId: `${job.packageName}@${job.version}`,
          metadata: { source: "gateway", reason: job.reason, priority: job.priority }
        })
      )
    );

    return reply.code(202).send({ ok: true, queued: jobs.length, jobs });
  });

  app.post<{
    Body: { packageName: string; version: string };
  }>("/-/anvil/explain", async (request, reply) => {
    const result = await explainVersion(request.body.packageName, request.body.version);
    if (!result) return reply.code(404).send({ error: "ANVIL_VERSION_NOT_FOUND" });
    return result;
  });

  app.post<{
    Body: { packageName: string; version?: string; action?: "allow" | "warn" | "quarantine" | "block"; reason: string; approvedBy?: string };
  }>("/-/anvil/override", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    const override = {
      packageName: request.body.packageName,
      version: request.body.version,
      action: request.body.action ?? "allow",
      reason: request.body.reason,
      approvedBy: request.body.approvedBy ?? "local-admin"
    };
    await persistence.putOverride(override);
    if (override.version) await persistence.deletePolicyDecision(override.packageName, override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: override.approvedBy,
      eventType: "override.created",
      targetType: "package",
      targetId: `${override.packageName}${override.version ? `@${override.version}` : ""}`,
      metadata: { source: "gateway", action: override.action, reason: override.reason }
    });

    return reply.code(201).send({ ok: true });
  });

  app.post<{
    Body: { packageName: string; version?: string; revokedBy?: string };
  }>("/-/anvil/override/revoke", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    if (!request.body.packageName) return reply.code(400).send({ error: "ANVIL_OVERRIDE_REVOKE_REQUIRES_PACKAGE" });

    const revoked = await persistence.revokeOverride(request.body.packageName, request.body.version, request.body.revokedBy ?? "local-admin");
    if (!revoked) return reply.code(404).send({ error: "ANVIL_OVERRIDE_NOT_FOUND" });

    if (revoked.override.version) await persistence.deletePolicyDecision(revoked.override.packageName, revoked.override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(revoked.override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: request.body.revokedBy ?? "local-admin",
      eventType: "override.revoked",
      targetType: "package",
      targetId: `${revoked.override.packageName}${revoked.override.version ? `@${revoked.override.version}` : ""}`,
      metadata: { source: "gateway", action: revoked.override.action, reason: revoked.override.reason }
    });

    return { ok: true };
  });

  app.post<{
    Body: { source?: string; projectName?: string; reportType?: string; summary?: Record<string, unknown>; report?: unknown };
  }>("/-/anvil/node-base/reports", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    if (!request.body || !request.body.reportType || request.body.report === undefined) {
      return reply.code(400).send({ error: "ANVIL_NODE_BASE_REPORT_REQUIRES_TYPE_AND_REPORT" });
    }

    const record = await persistence.putNodeBaseReport({
      source: request.body.source || "anvil-node-base",
      projectName: request.body.projectName || undefined,
      reportType: request.body.reportType,
      summary: request.body.summary,
      report: request.body.report
    });
    await persistence.putAuditEvent({
      actor: request.body.source || "anvil-node-base",
      eventType: "node_base_report.submitted",
      targetType: "node_base_report",
      targetId: record.id ?? `${record.source}:${record.createdAt ?? ""}`,
      metadata: { reportType: record.reportType, projectName: record.projectName }
    });

    return reply.code(201).send({ ok: true, report: record });
  });

  app.get<{ Params: { packageName: string } }>("/:packageName", async (request) => {
    return handleMetadataRequest(request.params.packageName);
  });

  app.get<{ Params: { scope: string; packageName: string } }>("/@:scope/:packageName", async (request) => {
    return handleMetadataRequest(decodeRoutePackageName(request.params.scope, request.params.packageName));
  });

  app.get<{ Params: { packageName: string; tarballName: string } }>("/:packageName/-/:tarballName", async (request, reply) => {
    return handleTarballRequest(request.params.packageName, request.params.tarballName, reply);
  });

  app.get<{ Params: { scope: string; packageName: string; tarballName: string } }>(
    "/@:scope/:packageName/-/:tarballName",
    async (request, reply) => {
      return handleTarballRequest(decodeRoutePackageName(request.params.scope, request.params.packageName), request.params.tarballName, reply);
    }
  );

  async function handleMetadataRequest(packageName: string) {
    const metadata = await fetchMetadata(packageName);
    const decisions = new Map<string, PolicyDecision>();
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);

    for (const version of Object.keys(metadata.versions ?? {})) {
      const decision = await evaluateAndCache(metadata, version, "metadata_request", weeklyDownloads);
      decisions.set(version, decision);
    }

    const filtered = filterMetadataVersions(metadata, decisions, {
      hideQuarantined: config.policy.hideQuarantinedMetadata || config.RUNTIME_MODE !== "development"
    });

    return rewriteMetadataTarballs(filtered, config.PUBLIC_BASE_URL);
  }

  async function handleTarballRequest(packageName: string, tarballName: string, reply: FastifyReply) {
    const metadata = await fetchMetadata(packageName);
    const version = resolveVersionFromTarballName(metadata, tarballName);
    if (!version) return reply.code(404).send({ error: "ANVIL_TARBALL_VERSION_NOT_FOUND", package: packageName, tarballName });
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);

    const decision = await evaluateAndCache(metadata, version, "tarball_request", weeklyDownloads);
    if (isDecisionBlockingInstall(decision, config.RUNTIME_MODE)) {
      return reply.code(decision.action === "quarantine" ? 423 : 403).send(buildAnvilError(packageName, version, decision));
    }

    const versionMetadata = toVersionMetadata(metadata, version);
    if (!versionMetadata?.tarballUrl) return reply.code(502).send({ error: "ANVIL_UPSTREAM_TARBALL_MISSING", package: packageName, version });

    const cacheKey = tarballCacheKey(packageName, version, versionMetadata.integrity ?? versionMetadata.shasum ?? tarballName);
    const cached = await objectStore.get(cacheKey);
    if (cached) {
      reply.header("content-type", "application/octet-stream");
      reply.header("x-anvil-cache", "hit");
      return reply.send(Buffer.from(cached));
    }

    const tarball = await registry.fetchTarball(versionMetadata.tarballUrl);
    await objectStore.put(cacheKey, tarball);
    await persistence.putPackageVersion({ packageName, version, cachedTarballKey: cacheKey });
    reply.header("content-type", "application/octet-stream");
    reply.header("x-anvil-cache", "miss");
    return reply.send(Buffer.from(tarball));
  }

  async function fetchMetadata(packageName: string): Promise<NpmPackageMetadata> {
    const cached = await persistence.getMetadata(packageName);
    if (cached) return cached as NpmPackageMetadata;
    const metadata = await registry.fetchMetadata(packageName);
    await persistence.putMetadata(packageName, metadata);
    return metadata;
  }

  async function persistPackageVersions(metadata: NpmPackageMetadata, weeklyDownloads?: number) {
    await Promise.all(
      Object.keys(metadata.versions ?? {}).map(async (version) => {
        const versionMetadata = toVersionMetadata(metadata, version);
        if (!versionMetadata) return;
        await persistence.putPackageVersion({
          packageName: metadata.name,
          version,
          publishedAt: versionMetadata.publishedAt,
          tarballUrl: versionMetadata.tarballUrl,
          integrity: versionMetadata.integrity,
          shasum: versionMetadata.shasum,
          weeklyDownloads
        });
      })
    );
  }

  async function explainVersion(packageName: string, requestedVersion: string) {
    const metadata = await fetchMetadata(packageName);
    const version = requestedVersion === "latest" ? metadata["dist-tags"]?.latest : requestedVersion;
    if (!version || !metadata.versions?.[version]) return undefined;
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);
    const decision = await evaluateAndCache(metadata, version, "metadata_request", weeklyDownloads);
    const [analysisReport, llmRiskReviews, override] = await Promise.all([
      persistence.getAnalysisReport(packageName, version),
      persistence.listLlmRiskReviews({ packageName, version, limit: 5 }),
      persistence.getOverride(packageName, version)
    ]);

    return {
      packageName,
      version,
      decision,
      analysisReport,
      llmRiskReviews,
      override
    };
  }

  async function evaluateAndCache(metadata: NpmPackageMetadata, version: string, reason: "metadata_request" | "tarball_request", weeklyDownloads?: number) {
    const packageName = metadata.name;
    const versionMetadata = toVersionMetadata(metadata, version);
    const [analysisReport, latestLlmReview] = await Promise.all([
      persistence.getAnalysisReport(packageName, version),
      config.policy.llmReview.enabled ? persistence.listLlmRiskReviews({ packageName, version, limit: 1 }) : Promise.resolve([])
    ]);
    const decisionIdentity = {
      tarballIntegrity: versionMetadata?.integrity,
      tarballShasum: versionMetadata?.shasum,
      analyserVersion: analysisReport?.analyserVersion ?? metadataPolicyAnalyserVersion
    };
    const existing = await persistence.getPolicyDecision(packageName, version, config.policy.version, decisionIdentity);
    if (existing) return existing;

    const similarPackages = detectNameSquatting(packageName).map((signal) => ({
      name: signal.candidate,
      similarity: signal.similarity,
      weeklyDownloads: signal.weeklyDownloads
    }));

    const decision = evaluatePolicy({
      packageName,
      version,
      runtimeMode: config.RUNTIME_MODE,
      metadata: { name: packageName, distTags: metadata["dist-tags"], publishedAt: metadata.time?.created },
      versionMetadata,
      packageAgeDays: calculatePackageAgeDays(versionMetadata?.publishedAt),
      weeklyDownloads,
      similarPackages,
      override: await persistence.getOverride(packageName, version),
      analysisReport,
      llmRiskReview: latestLlmReview[0]?.review,
      policy: config.policy
    });

    await persistence.putPolicyDecision(packageName, version, config.policy.version, decision, decisionIdentity);
    await persistence.putAuditEvent(buildPolicyDecisionAuditEvent({
      actor: "anvil-gateway",
      source: reason,
      packageName,
      version,
      policyVersion: config.policy.version,
      decision,
      identity: decisionIdentity
    }));

    if (decision.action !== "allow") {
      await queue.enqueueAnalysisJob({
        packageName,
        version,
        reason,
        priority: decision.action === "block" ? "high" : "normal",
        createdAt: new Date().toISOString()
      });
    }

    return decision;
  }

  async function safeWeeklyDownloads(packageName: string): Promise<number | undefined> {
    try {
      return await downloadStats.getWeeklyDownloads(packageName);
    } catch (error) {
      app.log.warn({ packageName, error }, "Failed to fetch npm download stats");
      return undefined;
    }
  }

  async function readinessChecks(): Promise<Array<{ component: ReadinessComponent; ok: boolean; error?: string }>> {
    const checks: Array<{ component: ReadinessComponent; run?: () => Promise<void> }> = [
      { component: "persistence", run: persistence.healthCheck?.bind(persistence) },
      { component: "objectStore", run: objectStore.healthCheck?.bind(objectStore) },
      { component: "queue", run: queue.healthCheck?.bind(queue) }
    ];

    return Promise.all(
      checks.map(async (check) => {
        try {
          await check.run?.();
          return { component: check.component, ok: true };
        } catch (error) {
          return { component: check.component, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );
  }

  return app;
}

function tarballCacheKey(packageName: string, version: string, integrity: string) {
  const safeName = packageName.replace(/^@/, "").replace(/[\/:]/g, "__");
  const safeIntegrity = integrity.replace(/[\/:+=]/g, "_");
  return `tarballs/${safeName}/${version}/${safeIntegrity}.tgz`;
}

function analysisTargetsFromBody(body: {
  packageName?: string;
  version?: string;
  targets?: Array<{ packageName?: string; version?: string }>;
}) {
  const targets = body.targets?.length ? body.targets : body.packageName ? [{ packageName: body.packageName, version: body.version }] : [];
  const seen = new Set<string>();
  return targets
    .map((target) => ({
      packageName: target.packageName?.trim(),
      version: target.version?.trim() || "latest"
    }))
    .filter((target): target is { packageName: string; version: string } => Boolean(target.packageName))
    .filter((target) => {
      const key = `${target.packageName}@${target.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
