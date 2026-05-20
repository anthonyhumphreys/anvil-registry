import { describe, expect, it, vi } from "vitest";
import { parseLockfile, parseTarget, run, type CliDependencies } from "./index.js";

describe("cli", () => {
  it("parses scoped package targets", () => {
    expect(parseTarget("@tanstack/react-query@5.0.0")).toEqual({ packageName: "@tanstack/react-query", version: "5.0.0" });
    expect(parseTarget("@tanstack/react-query")).toEqual({ packageName: "@tanstack/react-query", version: "latest" });
  });

  it("parses package-lock dependencies", async () => {
    const targets = await parseLockfile("package-lock.json", async () =>
      JSON.stringify({
        packages: {
          "": { version: "1.0.0" },
          "node_modules/@scope/pkg": { version: "1.2.3" },
          "node_modules/lodash": { version: "4.17.21" },
          "node_modules/a/node_modules/b": { version: "1.0.0" }
        }
      })
    );

    expect(targets).toEqual([
      { packageName: "@scope/pkg", version: "1.2.3" },
      { packageName: "lodash", version: "4.17.21" }
    ]);
  });

  it("parses pnpm lock package entries", async () => {
    const targets = await parseLockfile(
      "pnpm-lock.yaml",
      async () => `lockfileVersion: '9.0'

packages:

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-test}

  lodash@4.17.21:
    resolution: {integrity: sha512-test}

importers:
  .: {}
`
    );

    expect(targets).toEqual([
      { packageName: "@scope/pkg", version: "1.2.3" },
      { packageName: "lodash", version: "4.17.21" }
    ]);
  });

  it("explains a package using the gateway", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "pkg",
          version: "1.0.0",
          decision: {
            action: "allow",
            score: 0,
            reasons: [],
            explanation: "pkg@1.0.0 is allowed by deterministic policy."
          }
        })
      ),
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["explain", "pkg@1.0.0"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/explain",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ packageName: "pkg", version: "1.0.0" }) })
    );
    expect(writes.join("")).toContain("Anvil allowed pkg@1.0.0");
  });

  it("prints analysis and LLM review context from explain responses", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "pkg",
          version: "1.0.0",
          decision: {
            action: "quarantine",
            score: 55,
            reasons: [{ code: "LLM_RISK_REVIEW_FLAGGED", message: "Install path behavior needs human review.", severity: "high" }],
            explanation: "pkg@1.0.0 is quarantined by deterministic policy."
          },
          analysisReport: {
            packageName: "pkg",
            version: "1.0.0",
            analyserVersion: "static-analysis-test",
            policyVersion: "test-policy",
            score: 25,
            signals: [{ code: "USES_PROCESS_ENV", message: "Package reads process.env in install-path code.", severity: "medium" }],
            createdAt: "2026-05-20T12:00:00.000Z"
          },
          llmRiskReviews: [
            {
              packageName: "pkg",
              version: "1.0.0",
              provider: "test-provider",
              model: "risk-reviewer",
              review: {
                riskLevel: "high",
                confidence: "medium",
                summary: "Install path behavior needs human review.",
                suspectedRiskTypes: ["install_script_abuse"],
                evidence: [{ signal: "USES_PROCESS_ENV", explanation: "Environment access in install-path code.", source: "code_snippet" }],
                recommendedAction: "quarantine"
              },
              createdAt: "2026-05-20T12:00:01.000Z"
            }
          ]
        })
      ),
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["explain", "pkg@1.0.0"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Analysis:");
    expect(writes.join("")).toContain("analyser: static-analysis-test");
    expect(writes.join("")).toContain("signals: USES_PROCESS_ENV");
    expect(writes.join("")).toContain("LLM review:");
    expect(writes.join("")).toContain("test-provider/risk-reviewer: high confidence=medium recommendation=quarantine");
    expect(writes.join("")).toContain("suspected risks: install_script_abuse");
  });

  it("ignores the pnpm argument separator", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true, upstream: "https://registry.npmjs.org", runtimeMode: "development" }))
    });

    await expect(run(["--", "doctor"], dependencies)).resolves.toBe(0);
  });

  it("scans lockfiles and fails for blocked packages", async () => {
    const dependencies = fakeDependencies({
      readFile: vi.fn(async () =>
        JSON.stringify({
          packages: {
            "node_modules/bad-pkg": { version: "1.0.0" }
          }
        })
      ),
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "bad-pkg",
          version: "1.0.0",
          decision: {
            action: "block",
            score: 95,
            reasons: [{ code: "SIMILAR_TO_POPULAR_PACKAGE", message: "Looks like something else.", severity: "critical" }],
            explanation: "bad-pkg@1.0.0 is blocked by deterministic policy."
          }
        })
      )
    });

    await expect(run(["scan", "package-lock.json"], dependencies)).resolves.toBe(1);
  });

  it("tests package.json dependency policy through the gateway", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      readFile: vi.fn(async () =>
        JSON.stringify({
          dependencies: {
            "bad-pkg": "^1.0.0",
            "ok-pkg": "^2.0.0"
          },
          devDependencies: {
            "warn-pkg": "^3.0.0"
          },
          optionalDependencies: {
            "file-pkg": "file:../file-pkg"
          }
        })
      ),
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { packageName: string; version: string };
        const action = body.packageName === "bad-pkg" ? "block" : body.packageName === "warn-pkg" ? "warn" : "allow";
        return jsonResponse({
          packageName: body.packageName,
          version: "latest",
          decision: {
            action,
            score: action === "block" ? 95 : action === "warn" ? 20 : 0,
            reasons:
              action === "allow"
                ? []
                : [{ code: action === "block" ? "SIMILAR_TO_POPULAR_PACKAGE" : "LOW_WEEKLY_DOWNLOADS", message: `${body.packageName} needs review.`, severity: action === "block" ? "critical" : "medium" }],
            explanation: `${body.packageName} is ${action}.`
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["policy", "test", "package.json"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/explain",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ packageName: "bad-pkg", version: "latest" }) })
    );
    expect(writes.join("")).toContain("Tested 3 dependency names from package.json using latest resolvable versions.");
    expect(writes.join("")).toContain("Use lockfile scan for exact installed versions.");
    expect(writes.join("")).toContain("Anvil blocked bad-pkg@latest");
    expect(writes.join("")).toContain("Anvil warned warn-pkg@latest");
  });

  it("posts approval overrides with admin token", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" }
    });

    const exitCode = await run(["approve", "pkg@1.0.0", "--reason", "intentional"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/override",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({ packageName: "pkg", version: "1.0.0", reason: "intentional", action: "allow" })
      })
    );
  });

  it("smoke tests gateway metadata and tarball proxying", async () => {
    const writes: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/-/ready")) return jsonResponse({ ok: true, checks: [{ component: "persistence", ok: true }] });
      if (url === "http://anvil.test/is-number") {
        return jsonResponse({
          name: "is-number",
          "dist-tags": { latest: "7.0.0" },
          versions: {
            "7.0.0": {
              dist: {
                tarball: "http://anvil.test/is-number/-/is-number-7.0.0.tgz"
              }
            }
          }
        });
      }
      if (url === "http://anvil.test/is-number/-/is-number-7.0.0.tgz") return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected URL ${url}`);
    });
    const dependencies = fakeDependencies({
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    await expect(run(["smoke"], dependencies)).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith("http://anvil.test/-/health", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/-/ready", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/is-number", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/is-number/-/is-number-7.0.0.tgz");
    expect(writes.join("")).toContain("Anvil smoke check passed.");
  });

  it("fails smoke tests when tarball URLs are not rewritten through the gateway", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/-/ready")) return jsonResponse({ ok: true });
        return jsonResponse({
          name: "pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: {
                tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"
              }
            }
          }
        });
      }) as unknown as typeof globalThis.fetch
    });

    await expect(run(["smoke", "pkg"], dependencies)).resolves.toBe(1);
    expect(dependencies.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Tarball URL was not rewritten through Anvil"));
  });

  it("lists Node Base reports through the admin API and fails when high findings exist", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/node-base/reports?limit=5&reportType=network&risk=high");
        return jsonResponse({
          reports: [
            {
              id: "report-1",
              source: "devcontainer",
              projectName: "demo",
              reportType: "network",
              summary: { outboundConnections: 2, high: 1, medium: 0 },
              report: { summary: { outboundConnections: 2, high: 1, medium: 0 } },
              createdAt: "2026-05-20T12:00:00.000Z"
            }
          ]
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["node-base", "reports", "--type", "network", "--risk", "high", "--limit", "5"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Node Base reports: 1 (network) risk=high");
    expect(writes.join("")).toContain("report-1 network demo");
    expect(writes.join("")).toContain("high=1 medium=0");
    expect(writes.join("")).toContain("2 connections");
  });

  it("prints a Node Base report detail with findings and connections", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/node-base/reports/report-1");
        return jsonResponse({
          report: {
            id: "report-1",
            source: "devcontainer",
            projectName: "demo",
            reportType: "network",
            summary: { outboundConnections: 1, high: 0, medium: 1 },
            report: {
              summary: { outboundConnections: 1, high: 0, medium: 1 },
              mediumConfidenceFindings: [{ code: "NON_STANDARD_PORT", source: "strace", line: 8, evidence: "connect(... htons(8080) ...)" }],
              networkSummary: {
                connections: [{ family: "AF_INET", address: "198.51.100.10", port: 8080, line: 8 }]
              },
              policy: {
                network: {
                  allowedPorts: [80, 443],
                  allowedHosts: ["registry.npmjs.org"],
                  blockedHosts: ["raw.githubusercontent.com"],
                  directIpSeverity: "medium",
                  nonStandardPortSeverity: "high"
                }
              }
            },
            createdAt: "2026-05-20T12:00:00.000Z"
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["node-base", "report", "report-1"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Node Base network report report-1");
    expect(writes.join("")).toContain("Risk: high=0 medium=1");
    expect(writes.join("")).toContain("NON_STANDARD_PORT");
    expect(writes.join("")).toContain("198.51.100.10:8080");
    expect(writes.join("")).toContain("Network policy:");
    expect(writes.join("")).toContain("allowed ports: 80, 443");
    expect(writes.join("")).toContain("blocked hosts: raw.githubusercontent.com");
    expect(writes.join("")).toContain("non-standard port severity: high");
  });
});

function fakeDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    fetch: vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    readFile: vi.fn(async () => ""),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    env: { ANVIL_REGISTRY_URL: "http://anvil.test" },
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
