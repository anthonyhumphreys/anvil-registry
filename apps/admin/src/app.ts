import Fastify, { type FastifyInstance } from "fastify";
import type { AnvilConfig } from "@anvil/config";
import { loadConfig } from "@anvil/config";
import {
  defaultPopularPackageIndexObjectKey,
  encodePopularPackageIndex,
  loadActivePopularPackageIndex,
  parsePopularPackageIndex,
  popularPackageIndexDatedObjectKey,
  type PopularPackageIndex
} from "@anvil/name-squatting";
import { createObjectStore, type ObjectStore } from "@anvil/object-store";
import {
  createPersistence,
  type AnalysisReportRecord,
  type AnvilPersistence,
  type AuditEventRecord,
  type LlmRiskReviewRecord,
  type NodeBaseReportRecord,
  type NodeBaseReportRisk,
  type OverrideRecord,
  type PackageVersionRecord,
  type PolicyConfigRecord,
  type PolicyDecisionRecord
} from "@anvil/persistence";
import { llmReviewRequestBodySchema, overrideCreateRequestSchema, overrideRevokeRequestSchema, resolveOverrideExpiry, type Override } from "@anvil/shared";

export type AdminDependencies = {
  config?: AnvilConfig;
  persistence?: AnvilPersistence;
  objectStore?: ObjectStore;
  fetch?: typeof fetch;
};

export function buildAdmin(dependencies: AdminDependencies = {}): FastifyInstance {
  const config = dependencies.config ?? loadConfig();
  const persistence = dependencies.persistence ?? createPersistence(config);
  const objectStore = dependencies.objectStore ?? createObjectStore(config);
  const fetchGateway = dependencies.fetch ?? globalThis.fetch;
  let popularPackageIndex = loadActivePopularPackageIndex({
    objectStore,
    objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
    indexPath: config.POPULAR_PACKAGE_INDEX_PATH
  });
  const app = Fastify({ logger: { name: "anvil-admin" } });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    done(null, Object.fromEntries(new URLSearchParams(text)));
  });
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!config.ADMIN_TOKEN || path === "/-/health" || path === "/-/admin/session" || path === "/-/admin/logout") return;
    if (isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN)) return;

    if (path.startsWith("/api/")) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    return reply.code(401).type("text/html").send(page("Anvil Admin", `${adminSessionPanel(false, false, true)}<p class="empty">Admin token required.</p>`));
  });

  app.get("/-/health", async () => ({ ok: true, service: "anvil-admin" }));

  app.get("/api/decisions", async (request) => {
    const query = request.query as { action?: string; limit?: string };
    const actions = query.action ? query.action.split(",").filter(isPolicyAction) : undefined;
    return { decisions: await persistence.listPolicyDecisions({ actions, limit: parseLimit(query.limit) }) };
  });

  app.get("/api/reports", async (request) => {
    const query = request.query as { limit?: string };
    return { reports: await persistence.listAnalysisReports({ limit: parseLimit(query.limit) }) };
  });

  app.get("/api/reports/:packageName/:version", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const report = await persistence.getAnalysisReport(params.packageName, params.version, analysisReportIdentityFromRequest(request.url, request.query));
    if (!report) return reply.code(404).send({ error: "ANVIL_REPORT_NOT_FOUND" });
    return { report };
  });

  app.get("/api/reports/:packageName/:version/artifact", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const report = await persistence.getAnalysisReport(params.packageName, params.version, analysisReportIdentityFromRequest(request.url, request.query));
    if (!report) return reply.code(404).send({ error: "ANVIL_REPORT_NOT_FOUND" });
    if (!report.objectKey) return reply.code(404).send({ error: "ANVIL_REPORT_ARTIFACT_NOT_STORED" });
    const artifact = await objectStore.get(report.objectKey);
    if (!artifact) return reply.code(404).send({ error: "ANVIL_REPORT_ARTIFACT_NOT_FOUND", objectKey: report.objectKey });
    reply.type("application/json");
    return reply.send(Buffer.from(artifact));
  });

  app.get("/api/packages/:packageName/:version/reports/compare", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const reports = await persistence.listAnalysisReports({ packageName: params.packageName, version: params.version, limit: 200 });
    const pair = selectAnalysisComparisonReports(reports, request.url, request.query);
    if (!pair) return reply.code(404).send({ error: "ANVIL_REPORT_COMPARISON_NOT_FOUND" });
    return {
      packageName: params.packageName,
      version: params.version,
      left: pair.left,
      right: pair.right,
      comparison: compareAnalysisReports(pair.left.report, pair.right.report)
    };
  });

  app.get("/api/overrides", async (request) => {
    const query = request.query as { packageName?: string; version?: string; limit?: string };
    return { overrides: await persistence.listOverrides({ packageName: query.packageName, version: query.version, limit: parseLimit(query.limit) }) };
  });

  app.get("/api/audit-events", async (request) => {
    const query = request.query as { targetId?: string; limit?: string };
    return { auditEvents: await persistence.listAuditEvents({ targetId: query.targetId, limit: parseLimit(query.limit) }) };
  });

  app.get("/api/policy", async () => ({ runtimeMode: config.RUNTIME_MODE, policy: config.policy, policyConfig: await recordEffectivePolicyConfig(persistence, config) }));

  app.get("/api/popular-package-index", async () => await popularPackageIndex);

  app.post<{
    Body: Record<string, unknown>;
  }>("/api/popular-package-index", async (request, reply) => {
    if (!isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    try {
      const generatedAt = typeof request.body.generatedAt === "string" ? request.body.generatedAt : new Date().toISOString();
      const index = {
        ...parsePopularPackageIndex({ ...request.body, generatedAt }, "upload"),
        generatedAt
      };
      const activeKey = config.POPULAR_PACKAGE_INDEX_OBJECT_KEY || defaultPopularPackageIndexObjectKey;
      const datedKey = popularPackageIndexDatedObjectKey(generatedAt);
      const encoded = encodePopularPackageIndex(index);
      await objectStore.put(datedKey, encoded);
      if (activeKey !== datedKey) await objectStore.put(activeKey, encoded);

      const storedIndex = { ...index, source: `object:${activeKey}` };
      popularPackageIndex = Promise.resolve(storedIndex);
      await persistence.putAuditEvent({
        actor: typeof request.body.uploadedBy === "string" ? request.body.uploadedBy : "admin-ui",
        eventType: "popular_index.updated",
        targetType: "popular_index",
        targetId: activeKey,
        metadata: { activeKey, datedKey, packageCount: index.popularPackages.length, knownConfusionCount: Object.keys(index.knownConfusions).length }
      });

      return reply.code(201).send({ ok: true, activeKey, datedKey, index: storedIndex });
    } catch (error) {
      return reply.code(400).send({ error: "ANVIL_POPULAR_INDEX_INVALID", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/node-base/reports", async (request) => {
    const query = request.query as { reportType?: string; risk?: string; limit?: string };
    return { reports: await persistence.listNodeBaseReports({ reportType: query.reportType, risk: parseNodeBaseRisk(query.risk), limit: parseLimit(query.limit) }) };
  });

  app.get("/api/node-base/reports/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const report = await persistence.getNodeBaseReport(params.id);
    if (!report) return reply.code(404).send({ error: "ANVIL_NODE_BASE_REPORT_NOT_FOUND" });
    return { report };
  });

  app.get("/api/packages/:packageName/:version/review", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const review = await loadPackageReview(persistence, params.packageName, params.version);
    if (!hasReviewEvidence(review)) return reply.code(404).send({ error: "ANVIL_PACKAGE_REVIEW_NOT_FOUND" });
    return { review };
  });

  app.get("/api/packages/:packageName/:version/decisions", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const decisions = await persistence.listPolicyDecisions({ packageName: params.packageName, version: params.version, limit: 200 });
    if (decisions.length === 0) return reply.code(404).send({ error: "ANVIL_PACKAGE_DECISIONS_NOT_FOUND" });
    return { packageName: params.packageName, version: params.version, decisions };
  });

  app.post<{
    Body: { token?: string };
  }>("/-/admin/session", async (request, reply) => {
    if (!config.ADMIN_TOKEN) return reply.redirect("/");
    if (request.body.token !== config.ADMIN_TOKEN) {
      return reply
        .code(401)
        .type("text/html")
        .send(page("Anvil Admin", `${adminSessionPanel(false, true, true)}<p class="empty">Invalid admin token.</p>`));
    }

    reply.header("set-cookie", serializeCookie("anvil_admin_token", request.body.token, { httpOnly: true, sameSite: "Lax", path: "/" }));
    return reply.redirect("/");
  });

  app.post("/-/admin/logout", async (_request, reply) => {
    reply.header(
      "set-cookie",
      serializeCookie("anvil_admin_token", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 })
    );
    return reply.redirect("/");
  });

  app.post<{
    Body: unknown;
  }>("/api/overrides", async (request, reply) => {
    if (!isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    const parsed = overrideCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_OVERRIDE_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;

    const expiresAt = resolveOverrideExpiry(body.expiresAt, config.policy.overrides.defaultExpiryDays);
    if (expiresAt === null) return reply.code(400).send({ error: "ANVIL_OVERRIDE_EXPIRES_AT_INVALID" });

    const override = {
      packageName: body.packageName,
      version: body.version,
      action: body.action,
      reason: body.reason,
      approvedBy: body.approvedBy ?? "admin-ui",
      expiresAt
    };
    await persistence.putOverride(override);
    if (override.version) await persistence.deletePolicyDecision(override.packageName, override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: override.approvedBy,
      eventType: "override.created",
      targetType: "package",
      targetId: `${override.packageName}${override.version ? `@${override.version}` : ""}`,
      metadata: { source: "admin", action: override.action, reason: override.reason, expiresAt: override.expiresAt }
    });

    return reply.code(201).send({ ok: true });
  });

  app.post<{
    Body: unknown;
  }>("/api/overrides/revoke", async (request, reply) => {
    if (!isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    const parsed = overrideRevokeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_OVERRIDE_REVOKE_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;

    const revoked = await persistence.revokeOverride(body.packageName, body.version, body.revokedBy ?? "admin-ui");
    if (!revoked) return reply.code(404).send({ error: "ANVIL_OVERRIDE_NOT_FOUND" });

    if (revoked.override.version) await persistence.deletePolicyDecision(revoked.override.packageName, revoked.override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(revoked.override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: body.revokedBy ?? "admin-ui",
      eventType: "override.revoked",
      targetType: "package",
      targetId: `${revoked.override.packageName}${revoked.override.version ? `@${revoked.override.version}` : ""}`,
      metadata: { source: "admin", action: revoked.override.action, reason: revoked.override.reason }
    });

    return { ok: true };
  });

  app.post<{
    Body: unknown;
    Params: { packageName: string; version: string };
  }>("/api/packages/:packageName/:version/llm-review", async (request, reply) => {
    if (!isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN)) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    if (!config.policy.llmReview.enabled) return reply.code(409).send({ error: "ANVIL_LLM_REVIEW_DISABLED" });

    const params = request.params as { packageName: string; version: string };
    const parsed = llmReviewRequestBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_LLM_REVIEW_REQUEST_INVALID", issues: validationIssues(parsed.error) });
    }
    const requestedBy = parsed.data.requestedBy ?? "admin-ui";
    const priority = parsed.data.priority ?? "high";
    const response = await fetchGateway(`${config.ANVIL_API_BASE_URL.replace(/\/+$/, "")}/-/anvil/llm-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.ADMIN_TOKEN ? { authorization: `Bearer ${config.ADMIN_TOKEN}` } : {})
      },
      body: JSON.stringify({
        packageName: params.packageName,
        version: params.version,
        requestedBy,
        priority
      })
    });
    const bodyText = await response.text();
    const body = parseJsonBody(bodyText);
    if (!response.ok) {
      return reply.code(response.status).send(body ?? { error: "ANVIL_LLM_REVIEW_REQUEST_FAILED", detail: bodyText || response.statusText });
    }

    return reply.code(202).send(body);
  });

  app.get("/", async (request, reply) => {
    const [decisions, reports, nodeBaseReports, overrides, auditEvents, activePopularPackageIndex] = await Promise.all([
      persistence.listPolicyDecisions({ limit: 50 }),
      persistence.listAnalysisReports({ limit: 20 }),
      persistence.listNodeBaseReports({ limit: 20 }),
      persistence.listOverrides({ limit: 20 }),
      persistence.listAuditEvents({ limit: 20 }),
      popularPackageIndex
    ]);
    const isAdmin = isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN);

    reply.type("text/html");
    return page(
      "Anvil Admin",
      `${adminSessionPanel(isAdmin, false, Boolean(config.ADMIN_TOKEN))}
      <section>
        <h2>Decision Summary</h2>
        <div class="summary">
          ${summaryTile("Blocked", countActions(decisions, "block"), "danger")}
          ${summaryTile("Quarantined", countActions(decisions, "quarantine"), "warn")}
          ${summaryTile("Warned", countActions(decisions, "warn"), "muted")}
          ${summaryTile("Allowed", countActions(decisions, "allow"), "ok")}
        </div>
      </section>
      <section>
        <h2>Policy Configuration</h2>
        <p><a href="/policy">View effective policy</a></p>
        ${policySummary(config)}
      </section>
      <section>
        <h2>Recent Decisions</h2>
        ${decisionTable(decisions)}
      </section>
      <section>
        <h2>Recent Analysis Reports</h2>
        ${reportTable(reports)}
      </section>
      <section>
        <h2>Node Base Reports</h2>
        <p><a href="/node-base/reports">View all Node Base reports</a></p>
        ${nodeBaseReportTypeSummary(nodeBaseReports)}
        ${nodeBaseReportTable(nodeBaseReports)}
      </section>
      <section>
        <h2>Popular Package Index</h2>
        <p><a href="/popular-package-index">View typo-squatting reference index</a></p>
        ${popularPackageIndexSummary(activePopularPackageIndex)}
      </section>
      <section>
        <h2>Overrides</h2>
        ${isAdmin ? overrideForm() : `<p class="empty">Enter the local admin token to create or revoke overrides.</p>`}
        ${overrideTable(overrides, isAdmin)}
      </section>
      <section>
        <h2>Audit Events</h2>
        ${auditEventTable(auditEvents)}
      </section>`
    );
  });

  app.get("/policy", async (_request, reply) => {
    const policyConfig = await recordEffectivePolicyConfig(persistence, config);
    reply.type("text/html");
    return page(
      "Policy Configuration",
      `<section>
        <h2>Effective Policy</h2>
        ${policySummary(config)}
      </section>
      <section>
        <h2>Persisted Snapshot</h2>
        ${policyConfigSummary(policyConfig)}
      </section>
      <section>
        <h2>Deterministic Gates</h2>
        ${policyDetails(config.policy)}
      </section>
      <section>
        <h2>Raw Policy</h2>
        <pre>${escapeHtml(JSON.stringify(config.policy, null, 2))}</pre>
      </section>`
    );
  });

  app.get("/packages/:packageName/:version", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const review = await loadPackageReview(persistence, params.packageName, params.version);
    if (!hasReviewEvidence(review)) return reply.code(404).type("text/html").send(page("Package Review Not Found", "<p>Package review not found.</p>"));
    const isAdmin = isAdminRequest(request.headers.authorization, request.headers.cookie, config.ADMIN_TOKEN);

    reply.type("text/html");
    return page(
      `${escapeHtml(params.packageName)}@${escapeHtml(params.version)}`,
      `${adminSessionPanel(isAdmin, false, Boolean(config.ADMIN_TOKEN))}
      <section>
        <h2>Review Summary</h2>
        <div class="summary">
          ${summaryTile("Current Decision", review.decisions[0]?.decision.action ?? "none", review.decisions[0]?.decision.action ?? "muted")}
          ${summaryTile("Decision Score", review.decisions[0]?.decision.score ?? 0, "muted")}
          ${summaryTile("Static Signals", review.reports[0]?.report.signals.length ?? 0, "warn")}
          ${summaryTile("Weekly Downloads", review.packageVersion?.weeklyDownloads ?? "unknown", "muted")}
          ${summaryTile("LLM Reviews", review.llmRiskReviews.length, "muted")}
          ${summaryTile("Overrides", review.overrides.length, "ok")}
        </div>
      </section>
      <section>
        <h2>Package Version</h2>
        ${packageVersionDetails(review.packageVersion)}
      </section>
      <section>
        <h2>Policy Decisions</h2>
        <p><a href="${decisionHistoryUrl(params.packageName, params.version)}">View decision history</a></p>
        ${decisionTable(review.decisions)}
      </section>
      <section>
        <h2>Analysis Reports</h2>
        ${review.reports.length > 1 ? `<p><a href="${escapeHtml(compareLatestAnalysisReportsUrl(review.reports))}">Compare latest reports</a></p>` : ""}
        ${reportTable(review.reports)}
        ${review.reports[0] ? `<h3>Latest Signals</h3>${signalList(review.reports[0].report.signals)}<h3>Provenance</h3>${provenanceDetails(review.reports[0].report.provenance)}${analysisComparisonSections(review.reports[0].report)}` : ""}
      </section>
      <section>
        <h2>LLM Risk Reviews</h2>
        ${llmReviewRequestPanel(params.packageName, params.version, isAdmin, config.policy.llmReview.enabled)}
        ${llmRiskReviewTable(review.llmRiskReviews)}
      </section>
      <section>
        <h2>Overrides</h2>
        ${isAdmin ? overrideForm(params.packageName, params.version) : `<p class="empty">Enter the local admin token to create or revoke overrides.</p>`}
        ${overrideTable(review.overrides, isAdmin)}
      </section>
      <section>
        <h2>Audit Events</h2>
        ${auditEventTable(review.auditEvents)}
      </section>`
    );
  });

  app.get("/packages/:packageName/:version/decisions", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const decisions = await persistence.listPolicyDecisions({ packageName: params.packageName, version: params.version, limit: 200 });
    if (decisions.length === 0) {
      return reply.code(404).type("text/html").send(page("Decision History Not Found", "<p>No policy decision history found.</p>"));
    }

    reply.type("text/html");
    return page(
      `Decision History ${escapeHtml(params.packageName)}@${escapeHtml(params.version)}`,
      `<section>
        <h2>Decision Timeline</h2>
        <div class="summary">
          ${summaryTile("Decisions", decisions.length, "muted")}
          ${summaryTile("Blocked", countActions(decisions, "block"), "danger")}
          ${summaryTile("Warned", countActions(decisions, "warn"), "warn")}
          ${summaryTile("Allowed", countActions(decisions, "allow"), "ok")}
        </div>
      </section>
      <section>
        <h2>Identity History</h2>
        ${decisionHistoryTable(decisions)}
      </section>
      <section>
        <h2>Raw Decisions</h2>
        <pre>${escapeHtml(JSON.stringify(decisions, null, 2))}</pre>
      </section>`
    );
  });

  app.get("/packages/:packageName/:version/reports/compare", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const reports = await persistence.listAnalysisReports({ packageName: params.packageName, version: params.version, limit: 200 });
    const pair = selectAnalysisComparisonReports(reports, request.url, request.query);
    if (!pair) {
      return reply.code(404).type("text/html").send(page("Report Comparison Not Found", "<p>Two analysis reports are required for comparison.</p>"));
    }

    const comparison = compareAnalysisReports(pair.left.report, pair.right.report);
    reply.type("text/html");
    return page(
      `Report Comparison ${escapeHtml(params.packageName)}@${escapeHtml(params.version)}`,
      `<section>
        <h2>Comparison Summary</h2>
        <div class="summary">
          ${summaryTile("Left Score", pair.left.report.score, "muted")}
          ${summaryTile("Right Score", pair.right.report.score, "muted")}
          ${summaryTile("Score Delta", comparison.scoreDelta, comparison.scoreDelta > 0 ? "warn" : "ok")}
          ${summaryTile("Added Signals", comparison.signals.added.length, comparison.signals.added.length ? "warn" : "muted")}
          ${summaryTile("Removed Signals", comparison.signals.removed.length, "muted")}
          ${summaryTile("Added File Findings", comparison.fileFindings.added.length, comparison.fileFindings.added.length ? "warn" : "muted")}
        </div>
      </section>
      <section>
        <h2>Report Identities</h2>
        ${analysisReportPairTable(pair.left, pair.right)}
      </section>
      <section>
        <h2>Signal Changes</h2>
        ${signalComparisonTable(comparison.signals)}
      </section>
      <section>
        <h2>Dependency Changes</h2>
        ${dependencyDiffComparisonTable(pair.left.report.dependencyDiff, pair.right.report.dependencyDiff)}
      </section>
      <section>
        <h2>Manifest Changes</h2>
        ${manifestDiffComparisonTable(pair.left.report.manifestDiff, pair.right.report.manifestDiff)}
      </section>
      <section>
        <h2>File Finding Changes</h2>
        ${fileFindingComparisonTable(comparison.fileFindings)}
      </section>`
    );
  });

  app.get("/reports/:packageName/:version", async (request, reply) => {
    const params = request.params as { packageName: string; version: string };
    const report = await persistence.getAnalysisReport(params.packageName, params.version, analysisReportIdentityFromRequest(request.url, request.query));
    if (!report) return reply.code(404).type("text/html").send(page("Report Not Found", "<p>Analysis report not found.</p>"));

    reply.type("text/html");
    return page(
      `${escapeHtml(report.packageName)}@${escapeHtml(report.version)}`,
      `<section>
        <h2>Analysis Report</h2>
        <dl>
          <dt>Analyser</dt><dd>${escapeHtml(report.analyserVersion)}</dd>
          <dt>Policy</dt><dd>${escapeHtml(report.policyVersion)}</dd>
          <dt>Tarball Integrity</dt><dd>${escapeHtml(report.tarballIntegrity ?? "")}</dd>
          <dt>Tarball Shasum</dt><dd>${escapeHtml(report.tarballShasum ?? "")}</dd>
          <dt>Object Store Key</dt><dd>${analysisReportObjectKeyDetails(report, analysisReportArtifactUrl(report))}</dd>
          <dt>Score</dt><dd>${report.score}</dd>
        </dl>
        <h3>Signals</h3>
        ${signalList(report.signals)}
        <h3>Provenance</h3>
        ${provenanceDetails(report.provenance)}
        ${analysisComparisonSections(report)}
        <h3>Raw Report</h3>
        <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
      </section>`
    );
  });

  app.get("/node-base/reports/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const report = await persistence.getNodeBaseReport(params.id);
    if (!report) return reply.code(404).type("text/html").send(page("Node Base Report Not Found", "<p>Node Base report not found.</p>"));

    reply.type("text/html");
    return page(
      `Node Base Report ${escapeHtml(report.reportType)}`,
      `<section>
        <h2>Report Summary</h2>
        <div class="summary">
          ${summaryTile("Type", report.reportType, "muted")}
          ${summaryTile("Source", report.source, "muted")}
          ${summaryTile("Project", report.projectName ?? "", "muted")}
          ${summaryTile("Created", formatDate(report.createdAt), "muted")}
        </div>
      </section>
      <section>
        <h2>Summary</h2>
        ${nodeBaseSummaryDetails(report)}
      </section>
      ${nodeBaseStructuredSections(report)}
      <section>
        <h2>Raw Report</h2>
        <pre>${escapeHtml(JSON.stringify(report.report, null, 2))}</pre>
      </section>`
    );
  });

  app.get("/node-base/reports", async (request, reply) => {
    const query = request.query as { reportType?: string; risk?: string; limit?: string };
    const risk = parseNodeBaseRisk(query.risk);
    const [reports, allReportsForSummary] = await Promise.all([
      persistence.listNodeBaseReports({ reportType: query.reportType, risk, limit: parseLimit(query.limit) ?? 100 }),
      persistence.listNodeBaseReports({ limit: 200 })
    ]);

    reply.type("text/html");
    return page(
      "Node Base Reports",
      `<section>
        <h2>Report Types</h2>
        ${nodeBaseReportTypeSummary(allReportsForSummary, query.reportType)}
        <h2>Risk</h2>
        ${nodeBaseRiskSummary(allReportsForSummary, risk, query.reportType)}
      </section>
      <section>
        <h2>${nodeBaseReportListHeading(query.reportType, risk)}</h2>
        ${nodeBaseReportTable(reports)}
      </section>`
    );
  });

  app.get("/popular-package-index", async (_request, reply) => {
    const activePopularPackageIndex = await popularPackageIndex;
    reply.type("text/html");
    return page(
      "Popular Package Index",
      `<section>
        <h2>Index Summary</h2>
        ${popularPackageIndexSummary(activePopularPackageIndex)}
      </section>
      <section>
        <h2>Popular Packages</h2>
        ${popularPackageTable(activePopularPackageIndex)}
      </section>
      <section>
        <h2>Known Ecosystem Confusions</h2>
        ${knownConfusionTable(activePopularPackageIndex)}
      </section>`
    );
  });

  return app;
}

async function recordEffectivePolicyConfig(persistence: AnvilPersistence, config: AnvilConfig) {
  return persistence.putPolicyConfig({
    name: "effective",
    version: config.policy.version,
    active: true,
    config: {
      runtimeMode: config.RUNTIME_MODE,
      policy: config.policy
    }
  });
}

async function loadPackageReview(persistence: AnvilPersistence, packageName: string, version: string) {
  const [packageVersion, decisions, reports, llmRiskReviews, overrides, auditEvents] = await Promise.all([
    persistence.getPackageVersion(packageName, version),
    persistence.listPolicyDecisions({ packageName, version, limit: 20 }),
    persistence.listAnalysisReports({ packageName, version, limit: 20 }),
    persistence.listLlmRiskReviews({ packageName, version, limit: 20 }),
    persistence.listOverrides({ packageName, version, limit: 20 }),
    persistence.listAuditEvents({ targetId: `${packageName}@${version}`, limit: 50 })
  ]);

  return { packageName, version, packageVersion, decisions, reports, llmRiskReviews, overrides, auditEvents };
}

function hasReviewEvidence(review: Awaited<ReturnType<typeof loadPackageReview>>) {
  return Boolean(review.packageVersion) || review.decisions.length > 0 || review.reports.length > 0 || review.llmRiskReviews.length > 0 || review.overrides.length > 0 || review.auditEvents.length > 0;
}

function countActions(decisions: PolicyDecisionRecord[], action: string) {
  return decisions.filter((record) => record.decision.action === action).length;
}

function decisionTable(decisions: PolicyDecisionRecord[]) {
  if (decisions.length === 0) return `<p class="empty">No policy decisions yet.</p>`;
  return `<table>
    <thead><tr><th>Package</th><th>Action</th><th>Score</th><th>Reason</th><th>Identity</th><th>Created</th></tr></thead>
    <tbody>${decisions
      .map(
        (record) => `<tr>
          <td><a href="${reviewUrl(record.packageName, record.version)}">${escapeHtml(record.packageName)}@${escapeHtml(record.version)}</a></td>
          <td><span class="pill ${escapeHtml(record.decision.action)}">${escapeHtml(record.decision.action)}</span></td>
          <td>${record.decision.score}</td>
          <td>${escapeHtml(record.decision.reasons[0]?.message ?? record.decision.explanation)}</td>
          <td>${decisionIdentityDetails(record)}</td>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function decisionHistoryTable(decisions: PolicyDecisionRecord[]) {
  if (decisions.length === 0) return `<p class="empty">No policy decision history yet.</p>`;
  return `<table>
    <thead><tr><th>Created</th><th>Action</th><th>Score</th><th>Tarball Integrity</th><th>Shasum</th><th>Analyser</th><th>Reason</th></tr></thead>
    <tbody>${decisions
      .map(
        (record) => `<tr>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
          <td><span class="pill ${escapeHtml(record.decision.action)}">${escapeHtml(record.decision.action)}</span></td>
          <td>${record.decision.score}</td>
          <td>${escapeHtml(record.tarballIntegrity ?? "")}</td>
          <td>${escapeHtml(record.tarballShasum ?? "")}</td>
          <td>${escapeHtml(record.analyserVersion ?? "")}</td>
          <td>${escapeHtml(record.decision.reasons[0]?.message ?? record.decision.explanation)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function packageVersionDetails(version: PackageVersionRecord | undefined) {
  if (!version) return `<p class="empty">No package version metadata yet.</p>`;
  return `<dl>
    <dt>Published</dt><dd>${escapeHtml(formatDate(version.publishedAt))}</dd>
    <dt>Weekly Downloads</dt><dd>${escapeHtml(version.weeklyDownloads ?? "unknown")}</dd>
    <dt>Tarball URL</dt><dd>${escapeHtml(version.tarballUrl ?? "")}</dd>
    <dt>Integrity</dt><dd>${escapeHtml(version.integrity ?? "")}</dd>
    <dt>Shasum</dt><dd>${escapeHtml(version.shasum ?? "")}</dd>
    <dt>Cached Tarball</dt><dd>${escapeHtml(version.cachedTarballKey ?? "")}</dd>
    <dt>Updated</dt><dd>${escapeHtml(formatDate(version.updatedAt))}</dd>
  </dl>`;
}

function decisionIdentityDetails(record: PolicyDecisionRecord) {
  const parts = [
    record.tarballIntegrity ? `integrity: ${record.tarballIntegrity}` : undefined,
    record.tarballShasum ? `shasum: ${record.tarballShasum}` : undefined,
    record.analyserVersion ? `analyser: ${record.analyserVersion}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `<span>${escapeHtml(parts.join(" | "))}</span>` : `<span class="empty">legacy</span>`;
}

function analysisReportIdentityDetails(record: AnalysisReportRecord) {
  const parts = [
    record.tarballIntegrity ? `integrity: ${record.tarballIntegrity}` : undefined,
    record.tarballShasum ? `shasum: ${record.tarballShasum}` : undefined,
    record.analyserVersion ? `analyser: ${record.analyserVersion}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `<span>${escapeHtml(parts.join(" | "))}</span>` : `<span class="empty">legacy</span>`;
}

function reportTable(reports: AnalysisReportRecord[]) {
  if (reports.length === 0) return `<p class="empty">No analysis reports yet.</p>`;
  return `<table>
    <thead><tr><th>Package</th><th>Analyser</th><th>Signals</th><th>Score</th><th>Identity</th><th>Artifact</th><th>Created</th></tr></thead>
    <tbody>${reports
      .map(
        (record) => `<tr>
          <td><a href="${escapeHtml(analysisReportUrl(record))}">${escapeHtml(record.packageName)}@${escapeHtml(record.version)}</a></td>
          <td>${escapeHtml(record.report.analyserVersion)}</td>
          <td>${record.report.signals.length}</td>
          <td>${record.report.score}</td>
          <td>${analysisReportIdentityDetails(record)}</td>
          <td>${analysisReportObjectKeyDetails(record.report, analysisReportArtifactUrl(record))}</td>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function analysisReportObjectKeyDetails(report: { objectKey?: string }, artifactUrl?: string) {
  if (!report.objectKey) return `<span class="empty">not stored</span>`;
  const key = `<code>${escapeHtml(report.objectKey)}</code>`;
  return artifactUrl ? `<a href="${escapeHtml(artifactUrl)}">${key}</a>` : key;
}

function popularPackageIndexSummary(index: PopularPackageIndex) {
  return `<div class="summary">
    ${summaryTile("Source", index.source, "muted")}
    ${summaryTile("Generated", index.generatedAt ?? "unknown", "muted")}
    ${summaryTile("Packages", index.popularPackages.length, "ok")}
    ${summaryTile("Known Confusions", Object.keys(index.knownConfusions).length, "warn")}
  </div>`;
}

function popularPackageTable(index: PopularPackageIndex) {
  if (index.popularPackages.length === 0) return `<p class="empty">No popular packages configured.</p>`;
  return `<table>
    <thead><tr><th>Package</th><th>Weekly Downloads</th><th>Aliases</th></tr></thead>
    <tbody>${index.popularPackages
      .map(
        (record) => `<tr>
          <td>${escapeHtml(record.name)}</td>
          <td>${escapeHtml(record.weeklyDownloads ?? "unknown")}</td>
          <td>${escapeHtml(record.aliases?.join(", ") ?? "")}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function knownConfusionTable(index: PopularPackageIndex) {
  const rows = Object.entries(index.knownConfusions);
  if (rows.length === 0) return `<p class="empty">No known ecosystem confusions configured.</p>`;
  return `<table>
    <thead><tr><th>Requested Package</th><th>Likely Intended Package</th></tr></thead>
    <tbody>${rows
      .map(
        ([requested, suggested]) => `<tr>
          <td>${escapeHtml(requested)}</td>
          <td>${escapeHtml(suggested)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function selectAnalysisComparisonReports(reports: AnalysisReportRecord[], url: string, query: unknown) {
  if (reports.length < 2) return undefined;
  const leftIdentity = prefixedAnalysisReportIdentityFromRequest("left", url, query);
  const rightIdentity = prefixedAnalysisReportIdentityFromRequest("right", url, query);
  const left = hasIdentityFilter(leftIdentity) ? reports.find((record) => analysisReportRecordMatches(record, leftIdentity)) : reports[1];
  const right = hasIdentityFilter(rightIdentity) ? reports.find((record) => analysisReportRecordMatches(record, rightIdentity)) : reports[0];
  if (!left || !right) return undefined;
  return { left, right };
}

function compareAnalysisReports(left: AnalysisReportRecord["report"], right: AnalysisReportRecord["report"]) {
  return {
    scoreDelta: right.score - left.score,
    signals: compareItems(left.signals, right.signals, signalComparisonKey),
    fileFindings: compareItems(left.fileFindings ?? [], right.fileFindings ?? [], fileFindingComparisonKey)
  };
}

function compareItems<T>(left: T[], right: T[], keyFor: (item: T) => string) {
  const leftByKey = new Map(left.map((item) => [keyFor(item), item]));
  const rightByKey = new Map(right.map((item) => [keyFor(item), item]));
  return {
    added: right.filter((item) => !leftByKey.has(keyFor(item))),
    removed: left.filter((item) => !rightByKey.has(keyFor(item))),
    unchanged: right.filter((item) => leftByKey.has(keyFor(item)))
  };
}

function signalComparisonKey(signal: { code: string; message: string; severity: string }) {
  return `${signal.code}|${signal.message}|${signal.severity}`;
}

function fileFindingComparisonKey(finding: FileFindingView) {
  return `${finding.path}|${finding.code}|${finding.reason}|${finding.severity}|${formatEvidence(finding.evidence)}`;
}

function analysisReportPairTable(left: AnalysisReportRecord, right: AnalysisReportRecord) {
  return `<table>
    <thead><tr><th>Side</th><th>Analyser</th><th>Policy</th><th>Integrity</th><th>Shasum</th><th>Score</th><th>Signals</th><th>Created</th></tr></thead>
    <tbody>${[
      ["Left", left],
      ["Right", right]
    ]
      .map(
        ([label, record]) => `<tr>
          <td>${escapeHtml(label)}</td>
          <td>${escapeHtml((record as AnalysisReportRecord).report.analyserVersion)}</td>
          <td>${escapeHtml((record as AnalysisReportRecord).report.policyVersion)}</td>
          <td>${escapeHtml((record as AnalysisReportRecord).report.tarballIntegrity ?? (record as AnalysisReportRecord).tarballIntegrity ?? "")}</td>
          <td>${escapeHtml((record as AnalysisReportRecord).report.tarballShasum ?? (record as AnalysisReportRecord).tarballShasum ?? "")}</td>
          <td>${(record as AnalysisReportRecord).report.score}</td>
          <td>${(record as AnalysisReportRecord).report.signals.length}</td>
          <td>${escapeHtml(formatDate((record as AnalysisReportRecord).createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function signalComparisonTable(comparison: ReturnType<typeof compareAnalysisReports>["signals"]) {
  const rows = [
    ...comparison.added.map((signal) => ({ change: "added", signal })),
    ...comparison.removed.map((signal) => ({ change: "removed", signal })),
    ...comparison.unchanged.map((signal) => ({ change: "unchanged", signal }))
  ];
  if (rows.length === 0) return `<p class="empty">No signals in either report.</p>`;
  return `<table>
    <thead><tr><th>Change</th><th>Code</th><th>Severity</th><th>Message</th></tr></thead>
    <tbody>${rows
      .map(
        ({ change, signal }) => `<tr>
          <td><span class="pill">${escapeHtml(change)}</span></td>
          <td>${escapeHtml(signal.code)}</td>
          <td>${escapeHtml(signal.severity)}</td>
          <td>${escapeHtml(signal.message)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function dependencyDiffComparisonTable(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) {
  const leftRows = dependencyDiffRows(left);
  const rightRows = dependencyDiffRows(right);
  const keys = [...new Set([...leftRows.map(dependencyDiffRowKey), ...rightRows.map(dependencyDiffRowKey)])].sort();
  if (keys.length === 0) return `<p class="empty">No dependency changes captured in either report.</p>`;
  return `<table>
    <thead><tr><th>Group</th><th>Dependency</th><th>Left Change</th><th>Left Target</th><th>Right Change</th><th>Right Target</th></tr></thead>
    <tbody>${keys
      .map((key) => {
        const leftRow = leftRows.find((row) => dependencyDiffRowKey(row) === key);
        const rightRow = rightRows.find((row) => dependencyDiffRowKey(row) === key);
        const row = rightRow ?? leftRow;
        return `<tr>
          <td>${escapeHtml(row?.group ?? "")}</td>
          <td>${escapeHtml(row?.name ?? "")}</td>
          <td>${escapeHtml(leftRow?.change ?? "")}</td>
          <td>${escapeHtml(leftRow?.target ?? "")}</td>
          <td>${escapeHtml(rightRow?.change ?? "")}</td>
          <td>${escapeHtml(rightRow?.target ?? "")}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function manifestDiffComparisonTable(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) {
  const leftScripts = lifecycleScriptTarget(left);
  const rightScripts = lifecycleScriptTarget(right);
  const metadataRows = manifestMetadataComparisonRows(left, right);
  const scriptNames = [...new Set([...Object.keys(leftScripts), ...Object.keys(rightScripts)])].sort();
  if (scriptNames.length === 0 && metadataRows.length === 0) return `<p class="empty">No manifest changes captured in either report.</p>`;
  return `${scriptNames.length > 0 ? `<table>
    <thead><tr><th>Script</th><th>Left Target</th><th>Right Target</th></tr></thead>
    <tbody>${scriptNames
      .map(
        (name) => `<tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(leftScripts[name] ?? "")}</td>
          <td>${escapeHtml(rightScripts[name] ?? "")}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>` : `<p class="empty">No lifecycle script changes captured.</p>`}
  <h3>Metadata Field Changes</h3>
  ${manifestMetadataComparisonTable(metadataRows)}`;
}

function fileFindingComparisonTable(comparison: ReturnType<typeof compareAnalysisReports>["fileFindings"]) {
  const rows = [
    ...comparison.added.map((finding) => ({ change: "added", finding })),
    ...comparison.removed.map((finding) => ({ change: "removed", finding })),
    ...comparison.unchanged.map((finding) => ({ change: "unchanged", finding }))
  ];
  if (rows.length === 0) return `<p class="empty">No file findings in either report.</p>`;
  return `<table>
    <thead><tr><th>Change</th><th>Path</th><th>Code</th><th>Severity</th><th>Reason</th><th>Evidence</th></tr></thead>
    <tbody>${rows
      .map(
        ({ change, finding }) => `<tr>
          <td><span class="pill">${escapeHtml(change)}</span></td>
          <td>${escapeHtml(finding.path)}</td>
          <td>${escapeHtml(finding.code)}</td>
          <td>${escapeHtml(finding.severity)}</td>
          <td>${escapeHtml(finding.reason)}</td>
          <td>${escapeHtml(formatEvidence(finding.evidence))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function overrideTable(overrides: OverrideRecord[], canManage = false) {
  if (overrides.length === 0) return `<p class="empty">No overrides yet.</p>`;
  return `<table>
    <thead><tr><th>Package</th><th>Action</th><th>Status</th><th>Reason</th><th>Approved By</th><th>Created</th><th>Manage</th></tr></thead>
    <tbody>${overrides
      .map(
        (record) => {
          const status = overrideStatus(record);
          return `<tr>
          <td><a href="${reviewUrl(record.override.packageName, record.override.version ?? "*")}">${escapeHtml(overrideIdentity(record.override))}</a></td>
          <td><span class="pill ${escapeHtml(record.override.action)}">${escapeHtml(record.override.action)}</span></td>
          <td><span class="pill">${escapeHtml(status)}</span></td>
          <td>${escapeHtml(record.override.reason)}</td>
          <td>${escapeHtml(record.override.approvedBy ?? "")}</td>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
          <td>${canManage && status === "active" ? revokeForm(record.override) : ""}</td>
        </tr>`;
        }
      )
      .join("")}</tbody>
  </table>`;
}

function revokeForm(override: Override) {
  return `<form method="post" action="/api/overrides/revoke" class="inline-form">
    <input type="hidden" name="packageName" value="${escapeHtml(override.packageName)}" />
    <input type="hidden" name="version" value="${escapeHtml(override.version ?? "")}" />
    <button type="submit">Revoke</button>
  </form>`;
}

function auditEventTable(events: AuditEventRecord[]) {
  if (events.length === 0) return `<p class="empty">No audit events yet.</p>`;
  return `<table>
    <thead><tr><th>Event</th><th>Target</th><th>Actor</th><th>Metadata</th><th>Created</th></tr></thead>
    <tbody>${events
      .map(
        (event) => `<tr>
          <td>${escapeHtml(event.eventType)}</td>
          <td>${escapeHtml(event.targetType)}:${escapeHtml(event.targetId)}</td>
          <td>${escapeHtml(event.actor ?? "")}</td>
          <td>${escapeHtml(event.metadata ? JSON.stringify(event.metadata) : "")}</td>
          <td>${escapeHtml(formatDate(event.createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function llmRiskReviewTable(reviews: LlmRiskReviewRecord[]) {
  if (reviews.length === 0) return `<p class="empty">No LLM risk reviews yet.</p>`;
  return `<table>
    <thead><tr><th>Provider</th><th>Risk</th><th>Confidence</th><th>Recommendation</th><th>Summary</th><th>Created</th></tr></thead>
    <tbody>${reviews
      .map(
        (record) => `<tr>
          <td>${escapeHtml(record.provider)} / ${escapeHtml(record.model)}</td>
          <td><span class="pill ${escapeHtml(record.review.riskLevel)}">${escapeHtml(record.review.riskLevel)}</span></td>
          <td>${escapeHtml(record.review.confidence)}</td>
          <td><span class="pill ${escapeHtml(record.review.recommendedAction)}">${escapeHtml(record.review.recommendedAction)}</span></td>
          <td>${escapeHtml(record.review.summary)}</td>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function analysisComparisonSections(report: AnalysisReportRecord["report"]) {
  return `<h3>Manifest Changes</h3>
  ${manifestDiffDetails(report.manifestDiff)}
  <h3>Dependency Changes</h3>
  ${dependencyDiffDetails(report.dependencyDiff)}
  <h3>File Findings</h3>
  ${fileFindingList(report.fileFindings ?? [])}`;
}

function manifestDiffDetails(diff: Record<string, unknown> | undefined) {
  if (!diff || Object.keys(diff).length === 0) return `<p class="empty">No manifest diff captured.</p>`;
  const lifecycleScripts = isRecord(diff.lifecycleScripts) ? diff.lifecycleScripts : undefined;

  const previous = isRecord(lifecycleScripts?.previous) ? lifecycleScripts.previous : {};
  const target = isRecord(lifecycleScripts?.target) ? lifecycleScripts.target : {};
  const scriptNames = [...new Set([...Object.keys(previous), ...Object.keys(target)])].sort();
  const metadataRows = manifestMetadataRows(diff);

  if (scriptNames.length === 0 && metadataRows.length === 0) return `<p class="empty">No manifest changes captured.</p>`;
  return `${scriptNames.length > 0 ? `<table>
    <thead><tr><th>Script</th><th>Previous</th><th>Target</th></tr></thead>
    <tbody>${scriptNames
      .map(
        (name) => `<tr>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(previous[name] ?? "")}</td>
          <td>${escapeHtml(target[name] ?? "")}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>` : `<p class="empty">No lifecycle script changes captured.</p>`}
  <h3>Metadata Field Changes</h3>
  ${manifestMetadataTable(metadataRows)}`;
}

function dependencyDiffDetails(diff: Record<string, unknown> | undefined) {
  if (!diff || Object.keys(diff).length === 0) return `<p class="empty">No dependency diff captured.</p>`;
  const rows = dependencyDiffRows(diff);

  if (rows.length === 0) return `<p class="empty">No dependency changes captured.</p>`;
  return `<table>
    <thead><tr><th>Group</th><th>Dependency</th><th>Change</th><th>Previous</th><th>Target</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.group)}</td>
          <td>${escapeHtml(row.name)}</td>
          <td><span class="pill">${escapeHtml(row.change)}</span></td>
          <td>${escapeHtml(row.previous)}</td>
          <td>${escapeHtml(row.target)}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function dependencyDiffRows(diff: Record<string, unknown> | undefined) {
  const rows = [
    ...dependencyGroupRows("runtime", diff),
    ...dependencyGroupRows("dev", isRecord(diff?.dev) ? diff.dev : undefined),
    ...dependencyGroupRows("optional", isRecord(diff?.optional) ? diff.optional : undefined),
    ...dependencyGroupRows("peer", isRecord(diff?.peer) ? diff.peer : undefined)
  ];
  return rows.sort((left, right) => dependencyDiffRowKey(left).localeCompare(dependencyDiffRowKey(right)));
}

function dependencyGroupRows(group: string, diff: Record<string, unknown> | undefined) {
  const added = isRecord(diff?.added) ? Object.entries(diff.added).map(([name, version]) => ({ group, name, previous: "", target: version, change: "added" })) : [];
  const removed = isRecord(diff?.removed) ? Object.entries(diff.removed).map(([name, version]) => ({ group, name, previous: version, target: "", change: "removed" })) : [];
  const changed = isRecord(diff?.changed)
    ? Object.entries(diff.changed).map(([name, value]) => {
        const change = isRecord(value) ? value : {};
        return { group, name, previous: change.previous ?? "", target: change.target ?? "", change: "changed" };
      })
    : [];
  return [...added, ...removed, ...changed];
}

function dependencyDiffRowKey(row: { group: string; name: string }) {
  return `${row.group}:${row.name}`;
}

function lifecycleScriptTarget(diff: Record<string, unknown> | undefined) {
  const lifecycleScripts = isRecord(diff?.lifecycleScripts) ? diff.lifecycleScripts : {};
  return isRecord(lifecycleScripts.target) ? lifecycleScripts.target : {};
}

function manifestMetadataRows(diff: Record<string, unknown> | undefined) {
  const metadata = isRecord(diff?.metadata) ? diff.metadata : undefined;
  if (!metadata) return [];
  return Object.entries(metadata)
    .map(([field, value]) => {
      const change = isRecord(value) ? value : {};
      return { field, previous: change.previous, target: change.target };
    })
    .sort((left, right) => left.field.localeCompare(right.field));
}

function manifestMetadataTable(rows: Array<{ field: string; previous: unknown; target: unknown }>) {
  if (rows.length === 0) return `<p class="empty">No metadata field changes captured.</p>`;
  return `<table>
    <thead><tr><th>Field</th><th>Previous</th><th>Target</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.field)}</td>
          <td>${escapeHtml(formatManifestValue(row.previous))}</td>
          <td>${escapeHtml(formatManifestValue(row.target))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function manifestMetadataComparisonRows(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) {
  const leftRows = manifestMetadataRows(left);
  const rightRows = manifestMetadataRows(right);
  const fields = [...new Set([...leftRows.map((row) => row.field), ...rightRows.map((row) => row.field)])].sort();
  return fields.map((field) => ({
    field,
    left: leftRows.find((row) => row.field === field),
    right: rightRows.find((row) => row.field === field)
  }));
}

function manifestMetadataComparisonTable(rows: Array<{ field: string; left?: { target: unknown }; right?: { target: unknown } }>) {
  if (rows.length === 0) return `<p class="empty">No metadata field changes captured.</p>`;
  return `<table>
    <thead><tr><th>Field</th><th>Left Target</th><th>Right Target</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td>${escapeHtml(row.field)}</td>
          <td>${escapeHtml(formatManifestValue(row.left?.target))}</td>
          <td>${escapeHtml(formatManifestValue(row.right?.target))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function formatManifestValue(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function nodeBaseReportTable(reports: NodeBaseReportRecord[]) {
  if (reports.length === 0) return `<p class="empty">No Node Base reports yet.</p>`;
  return `<table>
    <thead><tr><th>Type</th><th>Source</th><th>Project</th><th>Highlights</th><th>Created</th></tr></thead>
    <tbody>${reports
      .map(
        (record) => `<tr>
          <td><a href="${nodeBaseReportUrl(record)}"><span class="pill ${escapeHtml(nodeBaseReportTone(record))}">${escapeHtml(record.reportType)}</span></a></td>
          <td>${escapeHtml(record.source)}</td>
          <td>${escapeHtml(record.projectName ?? "")}</td>
          <td>${nodeBaseReportHighlights(record)}</td>
          <td>${escapeHtml(formatDate(record.createdAt))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function nodeBaseReportTypeSummary(reports: NodeBaseReportRecord[], activeType?: string) {
  const types = ["dependency", "lifecycle", "ioc", "network"];
  const tiles = types
    .map((type) => {
      const count = reports.filter((report) => report.reportType === type).length;
      const href = `/node-base/reports?reportType=${encodeURIComponent(type)}`;
      const active = activeType === type ? " active" : "";
      return `<a class="tile-link${active}" href="${href}">${summaryTile(type, count, nodeBaseTypeTone(type))}</a>`;
    })
    .join("");
  const allHref = "/node-base/reports";
  return `<div class="summary"><a class="tile-link${activeType ? "" : " active"}" href="${allHref}">${summaryTile("all", reports.length, "muted")}</a>${tiles}</div>`;
}

function nodeBaseRiskSummary(reports: NodeBaseReportRecord[], activeRisk?: NodeBaseReportRisk, reportType?: string) {
  const scopedReports = reportType ? reports.filter((report) => report.reportType === reportType) : reports;
  const risks: Array<{ risk?: NodeBaseReportRisk; label: string; tone: string; count: number }> = [
    { label: "all", tone: "muted", count: scopedReports.length },
    { risk: "risky", label: "risky", tone: "quarantine", count: scopedReports.filter((report) => nodeBaseRiskMatches(report, "risky")).length },
    { risk: "high", label: "high", tone: "block", count: scopedReports.filter((report) => nodeBaseRiskMatches(report, "high")).length },
    { risk: "medium", label: "medium", tone: "warn", count: scopedReports.filter((report) => nodeBaseRiskMatches(report, "medium")).length }
  ];

  return `<div class="summary">${risks
    .map((item) => {
      const href = nodeBaseReportsHref({ reportType, risk: item.risk });
      const active = activeRisk === item.risk || (!activeRisk && !item.risk) ? " active" : "";
      return `<a class="tile-link${active}" href="${href}">${summaryTile(item.label, item.count, item.tone)}</a>`;
    })
    .join("")}</div>`;
}

function nodeBaseReportListHeading(reportType?: string, risk?: NodeBaseReportRisk) {
  const prefix = risk ? `${risk} ` : "";
  return reportType ? `${escapeHtml(prefix)}${escapeHtml(reportType)} Reports` : `${escapeHtml(prefix)}Recent Reports`;
}

function nodeBaseReportsHref(options: { reportType?: string; risk?: NodeBaseReportRisk }) {
  const params = new URLSearchParams();
  if (options.reportType) params.set("reportType", options.reportType);
  if (options.risk) params.set("risk", options.risk);
  const query = params.toString();
  return `/node-base/reports${query ? `?${query}` : ""}`;
}

function nodeBaseSummaryDetails(report: NodeBaseReportRecord) {
  if (!report.summary || Object.keys(report.summary).length === 0) return `<p class="empty">No summary fields.</p>`;
  return `<dl>${Object.entries(report.summary)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`)
    .join("")}</dl>`;
}

function nodeBaseStructuredSections(record: NodeBaseReportRecord) {
  const report = isRecord(record.report) ? record.report : {};
  const findings = [...arrayField(report.highConfidenceFindings), ...arrayField(report.mediumConfidenceFindings)];
  const processSummary = isRecord(report.processSummary) ? report.processSummary : undefined;
  const networkSummary = isRecord(report.networkSummary) ? report.networkSummary : undefined;
  const filesystemSummary = isRecord(report.filesystemSummary) ? report.filesystemSummary : undefined;
  const policy = isRecord(report.policy) ? report.policy : undefined;
  const networkPolicy = isRecord(policy?.network) ? policy.network : undefined;

  return [
    findings.length > 0 ? `<section><h2>IOC Findings</h2>${nodeBaseFindingTable(findings)}</section>` : "",
    processSummary ? `<section><h2>Process Summary</h2>${nodeBaseProcessSummary(processSummary)}</section>` : "",
    networkSummary ? `<section><h2>Network Summary</h2>${nodeBaseNetworkSummary(networkSummary)}</section>` : "",
    networkPolicy ? `<section><h2>Network Policy</h2>${nodeBaseNetworkPolicy(networkPolicy)}</section>` : "",
    filesystemSummary ? `<section><h2>Filesystem Summary</h2>${nodeBaseFilesystemSummary(filesystemSummary)}</section>` : ""
  ].join("");
}

function nodeBaseFindingTable(findings: unknown[]) {
  if (findings.length === 0) return `<p class="empty">No IOC findings captured.</p>`;
  return `<table>
    <thead><tr><th>Code</th><th>Source</th><th>Line</th><th>Evidence</th></tr></thead>
    <tbody>${findings
      .slice(0, 50)
      .map((item) => {
        const finding = isRecord(item) ? item : {};
        return `<tr>
          <td>${escapeHtml(finding.code ?? "")}</td>
          <td>${escapeHtml(finding.source ?? "")}</td>
          <td>${escapeHtml(finding.line ?? "")}</td>
          <td>${escapeHtml(finding.evidence ?? "")}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function nodeBaseProcessSummary(summary: Record<string, unknown>) {
  const commands = Array.isArray(summary.uniqueCommands) ? summary.uniqueCommands : [];
  const execs = Array.isArray(summary.execs) ? summary.execs : [];
  return `${nodeBaseCommandTable(commands)}<h3>Captured Execs</h3>${nodeBaseExecTable(execs)}`;
}

function nodeBaseCommandTable(commands: unknown[]) {
  if (commands.length === 0) return `<p class="empty">No process executions captured.</p>`;
  return `<table>
    <thead><tr><th>Command</th><th>Count</th></tr></thead>
    <tbody>${commands
      .slice(0, 25)
      .map((item) => {
        const command = isRecord(item) ? item.command : "";
        const count = isRecord(item) ? item.count : "";
        return `<tr><td>${escapeHtml(command)}</td><td>${escapeHtml(count)}</td></tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function nodeBaseExecTable(execs: unknown[]) {
  if (execs.length === 0) return `<p class="empty">No exec details captured.</p>`;
  return `<table>
    <thead><tr><th>PID</th><th>Command</th><th>Path</th><th>Args</th><th>Line</th></tr></thead>
    <tbody>${execs
      .slice(0, 25)
      .map((item) => {
        const exec = isRecord(item) ? item : {};
        return `<tr>
          <td>${escapeHtml(exec.pid ?? "")}</td>
          <td>${escapeHtml(exec.command ?? "")}</td>
          <td>${escapeHtml(exec.path ?? "")}</td>
          <td>${escapeHtml(Array.isArray(exec.args) ? exec.args.join(" ") : "")}</td>
          <td>${escapeHtml(exec.line ?? "")}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function nodeBaseNetworkSummary(summary: Record<string, unknown>) {
  const ports = Array.isArray(summary.byPort) ? summary.byPort : [];
  const connections = Array.isArray(summary.connections) ? summary.connections : [];
  return `${nodeBasePortTable(ports)}<h3>Captured Connections</h3>${nodeBaseConnectionTable(connections)}`;
}

function nodeBaseNetworkPolicy(policy: Record<string, unknown>) {
  const rows = [
    ["Allowed ports", formatList(policy.allowedPorts)],
    ["Allowed hosts", formatList(policy.allowedHosts)],
    ["Blocked hosts", formatList(policy.blockedHosts)],
    ["Suspicious hosts", formatList(policy.suspiciousHosts)],
    ["Direct IP severity", policy.directIpSeverity ?? "medium"],
    ["Non-standard port severity", policy.nonStandardPortSeverity ?? "medium"]
  ];
  return `<table>
    <thead><tr><th>Setting</th><th>Value</th></tr></thead>
    <tbody>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody>
  </table>`;
}

function nodeBasePortTable(ports: unknown[]) {
  if (ports.length === 0) return `<p class="empty">No outbound connections captured.</p>`;
  return `<table>
    <thead><tr><th>Port</th><th>Count</th></tr></thead>
    <tbody>${ports
      .slice(0, 25)
      .map((item) => {
        const port = isRecord(item) ? item.port : "";
        const count = isRecord(item) ? item.count : "";
        return `<tr><td>${escapeHtml(port)}</td><td>${escapeHtml(count)}</td></tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function nodeBaseConnectionTable(connections: unknown[]) {
  if (connections.length === 0) return `<p class="empty">No connection details captured.</p>`;
  return `<table>
    <thead><tr><th>PID</th><th>Family</th><th>Address</th><th>Port</th><th>Line</th></tr></thead>
    <tbody>${connections
      .slice(0, 25)
      .map((item) => {
        const connection = isRecord(item) ? item : {};
        return `<tr>
          <td>${escapeHtml(connection.pid ?? "")}</td>
          <td>${escapeHtml(connection.family ?? "")}</td>
          <td>${escapeHtml(connection.address ?? "")}</td>
          <td>${escapeHtml(connection.port ?? "")}</td>
          <td>${escapeHtml(connection.line ?? "")}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function nodeBaseFilesystemSummary(summary: Record<string, unknown>) {
  const accesses = Array.isArray(summary.sensitiveAccesses) ? summary.sensitiveAccesses : [];
  if (accesses.length === 0) return `<p class="empty">No sensitive file accesses captured.</p>`;
  return `<table>
    <thead><tr><th>PID</th><th>Syscall</th><th>Path</th><th>Line</th></tr></thead>
    <tbody>${accesses
      .slice(0, 25)
      .map((item) => {
        const access = isRecord(item) ? item : {};
        return `<tr>
          <td>${escapeHtml(access.pid ?? "")}</td>
          <td>${escapeHtml(access.syscall ?? "")}</td>
          <td>${escapeHtml(access.path ?? "")}</td>
          <td>${escapeHtml(access.line ?? "")}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function overrideForm(packageName = "", version = "") {
  return `<form method="post" action="/api/overrides" class="override-form">
    <input name="packageName" placeholder="package" aria-label="Package name" value="${escapeHtml(packageName)}" />
    <input name="version" placeholder="version" aria-label="Version" value="${escapeHtml(version)}" />
    <select name="action" aria-label="Action">
      <option value="allow">allow</option>
      <option value="warn">warn</option>
      <option value="quarantine">quarantine</option>
      <option value="block">block</option>
    </select>
    <input name="reason" placeholder="reason" aria-label="Reason" />
    <input name="expiresAt" placeholder="expires at" aria-label="Expires at" />
    <button type="submit">Create Override</button>
  </form>`;
}

function llmReviewRequestPanel(packageName: string, version: string, isAdmin: boolean, llmReviewEnabled: boolean) {
  if (!llmReviewEnabled) return `<p class="empty">LLM review is disabled for this environment.</p>`;
  if (!isAdmin) return `<p class="empty">Enter the local admin token to request LLM review.</p>`;
  return `<form method="post" action="${escapeHtml(llmReviewRequestUrl(packageName, version))}" class="llm-review-form">
    <input name="requestedBy" placeholder="requested by" aria-label="Requested by" value="admin-ui" />
    <select name="priority" aria-label="Priority">
      <option value="high">high</option>
      <option value="normal">normal</option>
      <option value="low">low</option>
    </select>
    <button type="submit">Request LLM Review</button>
  </form>`;
}

function adminSessionPanel(isAdmin: boolean, invalidToken: boolean, tokenRequired: boolean) {
  if (!tokenRequired) return "";
  if (!invalidToken && !isAdmin) {
    return `<section>
      <h2>Admin Token</h2>
      <form method="post" action="/-/admin/session" class="token-form">
        <input name="token" type="password" placeholder="local admin token" aria-label="Admin token" autocomplete="current-password" />
        <button type="submit">Unlock Overrides</button>
      </form>
    </section>`;
  }

  if (isAdmin) {
    return `<section>
      <h2>Admin Token</h2>
      <form method="post" action="/-/admin/logout" class="inline-form">
        <button type="submit">Lock Overrides</button>
      </form>
    </section>`;
  }

  return `<section>
    <h2>Admin Token</h2>
    <form method="post" action="/-/admin/session" class="token-form">
      <input name="token" type="password" placeholder="local admin token" aria-label="Admin token" autocomplete="current-password" />
      <button type="submit">Unlock Overrides</button>
    </form>
  </section>`;
}

function signalList(signals: Array<{ code: string; message: string; severity: string }>) {
  if (signals.length === 0) return `<p class="empty">No signals.</p>`;
  return `<ul>${signals.map((signal) => `<li><strong>${escapeHtml(signal.code)}</strong> ${escapeHtml(signal.message)} <span>${escapeHtml(signal.severity)}</span></li>`).join("")}</ul>`;
}

function provenanceDetails(provenance: AnalysisReportRecord["report"]["provenance"]) {
  if (!provenance) return `<p class="empty">No provenance metadata captured.</p>`;
  return `<dl>
    <dt>Status</dt><dd>${escapeHtml(provenance.status)}</dd>
    <dt>Target Present</dt><dd>${escapeHtml(provenance.target?.present ?? false)}</dd>
    <dt>Target Source</dt><dd>${escapeHtml(provenance.target?.source ?? "")}</dd>
    <dt>Target Attestation</dt><dd>${escapeHtml(provenance.target?.attestationUrl ?? "")}</dd>
    <dt>Previous Present</dt><dd>${escapeHtml(provenance.previous?.present ?? false)}</dd>
    <dt>Previous Source</dt><dd>${escapeHtml(provenance.previous?.source ?? "")}</dd>
    <dt>Previous Attestation</dt><dd>${escapeHtml(provenance.previous?.attestationUrl ?? "")}</dd>
    <dt>Verification Status</dt><dd>${escapeHtml(provenance.verification?.status ?? "")}</dd>
    <dt>Verified</dt><dd>${escapeHtml(provenance.verification?.verified ?? false)}</dd>
    <dt>Verifier</dt><dd>${escapeHtml(provenance.verification?.verifier ?? "")}</dd>
    <dt>Verification Summary</dt><dd>${escapeHtml(provenance.verification?.summary ?? "")}</dd>
    <dt>Subject</dt><dd>${escapeHtml(provenance.verification?.subjectName ?? "")}</dd>
    <dt>Expected Subject</dt><dd>${escapeHtml(provenance.verification?.expectedSubjectName ?? "")}</dd>
  </dl>`;
}

type FileFindingView = { path: string; code: string; reason: string; severity: string; evidence?: Record<string, unknown> };

function fileFindingList(findings: FileFindingView[]) {
  if (findings.length === 0) return `<p class="empty">No file findings.</p>`;
  return `<table>
    <thead><tr><th>Path</th><th>Code</th><th>Severity</th><th>Reason</th><th>Evidence</th></tr></thead>
    <tbody>${findings
      .map(
        (finding) => `<tr>
          <td>${escapeHtml(finding.path)}</td>
          <td>${escapeHtml(finding.code)}</td>
          <td>${escapeHtml(finding.severity)}</td>
          <td>${escapeHtml(finding.reason)}</td>
          <td>${escapeHtml(formatEvidence(finding.evidence))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function formatEvidence(evidence: Record<string, unknown> | undefined) {
  if (!evidence || Object.keys(evidence).length === 0) return "";
  return Object.entries(evidence)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${formatEvidenceValue(value)}`)
    .join(" | ");
}

function formatEvidenceValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function summaryTile(label: string, value: unknown, tone: string) {
  return `<div class="tile ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function policySummary(config: AnvilConfig) {
  return `<div class="summary">
    ${summaryTile("Runtime", config.RUNTIME_MODE, "muted")}
    ${summaryTile("Policy Version", config.policy.version, "muted")}
    ${summaryTile("Package Age", `${config.policy.minimumPackageAgeDays} days`, "warn")}
    ${summaryTile("LLM Review", config.policy.llmReview.enabled ? "enabled" : "disabled", config.policy.llmReview.enabled ? "warn" : "muted")}
  </div>`;
}

function policyConfigSummary(record: PolicyConfigRecord) {
  return settingTable([
    ["Name", record.name],
    ["Version", record.version],
    ["Active", record.active],
    ["Created", record.createdAt ?? "unknown"]
  ]);
}

function policyDetails(policy: AnvilConfig["policy"]) {
  return settingTable([
    ["Minimum package age", `${policy.minimumPackageAgeDays} days`],
    ["Compare previous versions", policy.comparePreviousVersions],
    ["Low download threshold", policy.lowDownloadThreshold],
    ["Strict low download threshold", policy.strictLowDownloadThreshold],
    ["Block similar low-download packages", policy.blockSimilarLowDownloadPackages],
    ["Block new install scripts", policy.blockNewInstallScripts],
    ["Quarantine changed install scripts", policy.quarantineChangedInstallScripts],
    ["Block unexpected binaries", policy.blockUnexpectedBinaries],
    ["Quarantine obfuscated code", policy.quarantineObfuscatedCode],
    ["Hide quarantined metadata", policy.hideQuarantinedMetadata],
    ["Provenance enabled", policy.provenance.enabled],
    ["Provenance high-download threshold", policy.provenance.highDownloadThreshold],
    ["Trusted publishing score reduction", policy.provenance.trustedPublishingScoreReduction],
    ["Quarantine changed provenance", policy.provenance.quarantineChangedProvenance],
    ["Quarantine missing provenance for high-download packages", policy.provenance.quarantineMissingForHighDownloadPackages],
    ["Overrides enabled", policy.overrides.enabled],
    ["Override reason required", policy.overrides.requireReason],
    ["Override default expiry", `${policy.overrides.defaultExpiryDays} days`],
    ["LLM review enabled", policy.llmReview.enabled],
    ["LLM review unknown packages", policy.llmReview.runOnUnknownPackages],
    ["LLM review quarantine", policy.llmReview.runOnQuarantine],
    ["LLM review private packages", policy.llmReview.includePrivatePackages],
    ["LLM provider", policy.llmReview.provider ?? "(none)"],
    ["LLM model", policy.llmReview.model ?? "(none)"]
  ]);
}

function settingTable(rows: Array<[string, unknown]>) {
  return `<table>
    <thead><tr><th>Setting</th><th>Value</th></tr></thead>
    <tbody>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</tbody>
  </table>`;
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #1d2525; }
    body { margin: 0; }
    header { padding: 24px 32px 16px; border-bottom: 1px solid #d8ddd7; background: #ffffff; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px 24px 48px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    h3 { margin: 22px 0 8px; font-size: 15px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .tile { border: 1px solid #d8ddd7; background: #fff; border-radius: 8px; padding: 14px; }
    .tile span { display: block; color: #66706c; font-size: 13px; }
    .tile strong { display: block; margin-top: 6px; font-size: 28px; }
    .tile-link { color: inherit; text-decoration: none; }
    .tile-link.active .tile { border-color: #285e61; box-shadow: inset 0 0 0 1px #285e61; }
    .danger strong, .block { color: #b42318; }
    .warn strong, .quarantine { color: #ad5b00; }
    .ok strong, .allow { color: #1d7f4f; }
    .warn { color: #705f00; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8ddd7; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8ebe7; vertical-align: top; font-size: 14px; }
    th { color: #4f5b57; background: #f0f2ef; font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    a { color: #285e61; }
    pre { overflow: auto; background: #101414; color: #e9f1ee; padding: 14px; border-radius: 8px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; }
    dt { color: #66706c; }
    dd { margin: 0; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; background: #eef1ef; font-size: 12px; font-weight: 700; }
    .empty { color: #66706c; }
    .override-form { display: grid; grid-template-columns: 1.2fr .7fr .7fr 1.5fr 1fr auto; gap: 8px; margin-bottom: 12px; }
    .llm-review-form { display: grid; grid-template-columns: minmax(180px, 320px) minmax(120px, 160px) auto; gap: 8px; margin-bottom: 12px; max-width: 680px; }
    .token-form { display: grid; grid-template-columns: minmax(220px, 360px) auto; gap: 8px; max-width: 540px; }
    .inline-form { margin: 0; }
    input, select, button { min-height: 36px; border: 1px solid #c7ceca; border-radius: 6px; padding: 0 10px; background: #fff; font: inherit; }
    button { background: #1d2525; color: white; border-color: #1d2525; font-weight: 700; }
    @media (max-width: 760px) { header { padding: 20px; } main { padding: 16px; } .override-form, .llm-review-form { grid-template-columns: 1fr; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1></header>
  <main>${body}</main>
</body>
</html>`;
}

function parseLimit(value?: string) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 200);
}

function parseNodeBaseRisk(value?: string): NodeBaseReportRisk | undefined {
  return value === "high" || value === "medium" || value === "risky" ? value : undefined;
}

function analysisReportIdentityFromRequest(url: string, query: unknown) {
  const rawParams = new URLSearchParams(url.split("?")[1] ?? "");
  const values = isRecord(query) ? query : {};
  return {
    tarballIntegrity: queryStringValue(values.integrity) ?? rawParams.get("integrity") ?? undefined,
    tarballShasum: queryStringValue(values.shasum) ?? rawParams.get("shasum") ?? undefined,
    analyserVersion: queryStringValue(values.analyser) ?? rawParams.get("analyser") ?? undefined
  };
}

function prefixedAnalysisReportIdentityFromRequest(prefix: "left" | "right", url: string, query: unknown) {
  const rawParams = new URLSearchParams(url.split("?")[1] ?? "");
  const values = isRecord(query) ? query : {};
  const integrityKey = `${prefix}Integrity`;
  const shasumKey = `${prefix}Shasum`;
  const analyserKey = `${prefix}Analyser`;
  return {
    tarballIntegrity: queryStringValue(values[integrityKey]) ?? rawParams.get(integrityKey) ?? undefined,
    tarballShasum: queryStringValue(values[shasumKey]) ?? rawParams.get(shasumKey) ?? undefined,
    analyserVersion: queryStringValue(values[analyserKey]) ?? rawParams.get(analyserKey) ?? undefined
  };
}

function hasIdentityFilter(identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }) {
  return Boolean(identity.tarballIntegrity || identity.tarballShasum || identity.analyserVersion);
}

function analysisReportRecordMatches(record: AnalysisReportRecord, identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }) {
  return (
    (identity.tarballIntegrity === undefined || record.tarballIntegrity === identity.tarballIntegrity || record.report.tarballIntegrity === identity.tarballIntegrity) &&
    (identity.tarballShasum === undefined || record.tarballShasum === identity.tarballShasum || record.report.tarballShasum === identity.tarballShasum) &&
    (identity.analyserVersion === undefined || record.analyserVersion === identity.analyserVersion || record.report.analyserVersion === identity.analyserVersion)
  );
}

function queryStringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function formatDate(value?: string) {
  return value ? new Date(value).toISOString() : "";
}

function isPolicyAction(value: string): value is Override["action"] {
  return ["allow", "warn", "quarantine", "block"].includes(value);
}

function overrideIdentity(override: Override) {
  return `${override.packageName}${override.version ? `@${override.version}` : ""}`;
}

function reviewUrl(packageName: string, version: string) {
  return `/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

function decisionHistoryUrl(packageName: string, version: string) {
  return `/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/decisions`;
}

function llmReviewRequestUrl(packageName: string, version: string) {
  return `/api/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/llm-review`;
}

function analysisReportUrl(record: AnalysisReportRecord) {
  const params = new URLSearchParams();
  if (record.tarballIntegrity) params.set("integrity", record.tarballIntegrity);
  if (record.tarballShasum) params.set("shasum", record.tarballShasum);
  if (record.analyserVersion) params.set("analyser", record.analyserVersion);
  const query = params.toString();
  return `/reports/${encodeURIComponent(record.packageName)}/${encodeURIComponent(record.version)}${query ? `?${query}` : ""}`;
}

function analysisReportArtifactUrl(record: Pick<AnalysisReportRecord, "packageName" | "version" | "tarballIntegrity" | "tarballShasum" | "analyserVersion"> | AnalysisReportRecord["report"]) {
  const params = new URLSearchParams();
  if (record.tarballIntegrity) params.set("integrity", record.tarballIntegrity);
  if (record.tarballShasum) params.set("shasum", record.tarballShasum);
  if (record.analyserVersion) params.set("analyser", record.analyserVersion);
  const query = params.toString();
  return `/api/reports/${encodeURIComponent(record.packageName)}/${encodeURIComponent(record.version)}/artifact${query ? `?${query}` : ""}`;
}

function compareLatestAnalysisReportsUrl(reports: AnalysisReportRecord[]) {
  return reports.length >= 2 ? analysisReportComparisonUrl(reports[1], reports[0]) : "#";
}

function analysisReportComparisonUrl(left: AnalysisReportRecord, right: AnalysisReportRecord) {
  const params = new URLSearchParams();
  if (left.tarballIntegrity ?? left.report.tarballIntegrity) params.set("leftIntegrity", left.tarballIntegrity ?? left.report.tarballIntegrity ?? "");
  if (left.tarballShasum ?? left.report.tarballShasum) params.set("leftShasum", left.tarballShasum ?? left.report.tarballShasum ?? "");
  params.set("leftAnalyser", left.analyserVersion ?? left.report.analyserVersion);
  if (right.tarballIntegrity ?? right.report.tarballIntegrity) params.set("rightIntegrity", right.tarballIntegrity ?? right.report.tarballIntegrity ?? "");
  if (right.tarballShasum ?? right.report.tarballShasum) params.set("rightShasum", right.tarballShasum ?? right.report.tarballShasum ?? "");
  params.set("rightAnalyser", right.analyserVersion ?? right.report.analyserVersion);
  return `/packages/${encodeURIComponent(right.packageName)}/${encodeURIComponent(right.version)}/reports/compare?${params.toString()}`;
}

function nodeBaseReportUrl(report: NodeBaseReportRecord) {
  return report.id ? `/node-base/reports/${encodeURIComponent(report.id)}` : "#";
}

function nodeBaseReportHighlights(record: NodeBaseReportRecord) {
  const report = isRecord(record.report) ? record.report : {};
  const summary = record.summary ?? (isRecord(report.summary) ? report.summary : undefined);
  const parts = [
    numberHighlight(summary, "packagesWithLifecycleScripts", "lifecycle scripts"),
    numberHighlight(summary, "packagesWithFindings", "packages with findings"),
    aliasedNumberHighlight(summary, "high", "highConfidenceFindings", "high findings"),
    aliasedNumberHighlight(summary, "medium", "mediumConfidenceFindings", "medium findings"),
    numberHighlight(summary, "executedProcesses", "execs"),
    numberHighlight(summary, "outboundConnections", "connections"),
    numberHighlight(summary, "sensitiveFileAccesses", "sensitive files")
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0 && summary) parts.push(JSON.stringify(summary));
  return parts.length ? escapeHtml(parts.join(" | ")) : `<span class="empty">no summary</span>`;
}

function numberHighlight(summary: Record<string, unknown> | undefined, key: string, label: string) {
  const value = summary?.[key];
  return typeof value === "number" ? `${value} ${label}` : undefined;
}

function aliasedNumberHighlight(summary: Record<string, unknown> | undefined, primaryKey: string, compatibilityKey: string, label: string) {
  const count = aliasedSummaryCount(summary, primaryKey, compatibilityKey);
  return count > 0 ? `${count} ${label}` : undefined;
}

function nodeBaseReportTone(record: NodeBaseReportRecord) {
  const { high, medium } = nodeBaseRiskCounts(record);
  if (high > 0) return "block";
  if (medium > 0 || record.reportType === "network") return "quarantine";
  return nodeBaseTypeTone(record.reportType);
}

function nodeBaseRiskMatches(record: NodeBaseReportRecord, risk: NodeBaseReportRisk) {
  const { high, medium } = nodeBaseRiskCounts(record);
  if (risk === "high") return high > 0;
  if (risk === "medium") return high === 0 && medium > 0;
  return high > 0 || medium > 0;
}

function nodeBaseRiskCounts(record: NodeBaseReportRecord) {
  const report = isRecord(record.report) ? record.report : {};
  const summary = record.summary ?? (isRecord(report.summary) ? report.summary : undefined);
  return {
    high: aliasedSummaryCount(summary, "high", "highConfidenceFindings"),
    medium: aliasedSummaryCount(summary, "medium", "mediumConfidenceFindings")
  };
}

function aliasedSummaryCount(summary: Record<string, unknown> | undefined, primaryKey: string, compatibilityKey: string) {
  return Math.max(numberValue(summary?.[primaryKey]), numberValue(summary?.[compatibilityKey]));
}

function nodeBaseTypeTone(type: string) {
  if (type === "ioc") return "block";
  if (type === "network") return "quarantine";
  if (type === "lifecycle") return "warn";
  return "muted";
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

function overrideStatus(record: OverrideRecord) {
  if (record.revokedAt) return "revoked";
  if (record.override.expiresAt && Date.parse(record.override.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function isAdminRequest(authorization: string | undefined, cookieHeader: string | undefined, adminToken: string | undefined) {
  if (!adminToken) return true;
  if (authorization === `Bearer ${adminToken}`) return true;
  return parseCookies(cookieHeader).anvil_admin_token === adminToken;
}

function validationIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function parseJsonBody(bodyText: string): unknown | undefined {
  if (!bodyText) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

function parseCookies(cookieHeader: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader?.split(";") ?? []) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = safeDecodeURIComponent(valueParts.join("="));
  }
  return cookies;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: { path?: string; httpOnly?: boolean; sameSite?: "Lax" | "Strict"; maxAge?: number } = {}
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
