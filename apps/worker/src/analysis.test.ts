import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { loadConfig } from "@anvil/config";
import type { NpmPackageMetadata } from "@anvil/npm-registry";
import { MemoryPersistence } from "@anvil/persistence";
import { MetadataProvenanceVerifier } from "@anvil/provenance";
import { analyseAnalysisJob, analysePackageTarget, parsePackageTarget } from "./analysis.js";

describe("worker analysis", () => {
  it("parses scoped package targets", () => {
    expect(parsePackageTarget("@scope/pkg@1.2.3")).toEqual({ packageName: "@scope/pkg", version: "1.2.3" });
    expect(parsePackageTarget("@scope/pkg")).toEqual({ packageName: "@scope/pkg", version: "latest" });
  });

  it("persists analysis report and policy decision from manual target", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    const result = await analysePackageTarget("pkg@1.0.1", { config, registry, persistence });

    expect(result.report.signals.map((signal) => signal.code)).toContain("NEW_INSTALL_SCRIPT");
    expect(result.report.signals.map((signal) => signal.code)).toContain("USES_CHILD_PROCESS");
    expect(result.report.signals.map((signal) => signal.code)).toContain("OPTIONAL_DEPENDENCY_ADDED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("PEER_DEPENDENCY_CHANGED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("BIN_FIELD_CHANGED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("UNSAFE_TARBALL_SYMLINK");
    expect(result.report.fileFindings).toContainEqual(expect.objectContaining({ path: "link-out", code: "UNSAFE_TARBALL_SYMLINK", reason: "Tarball contains a symlink pointing outside the package.", evidence: { linkTarget: "../../outside", unsafe: true } }));
    expect(result.report.signals).toContainEqual(expect.objectContaining({ code: "UNSAFE_TARBALL_SYMLINK", evidence: expect.objectContaining({ path: "link-out", linkTarget: "../../outside" }) }));
    expect(result.report).toMatchObject({ tarballIntegrity: "sha512-new", tarballShasum: "newsum" });
    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(
      (await persistence.getPolicyDecision("pkg", "1.0.1", config.policy.version, {
        tarballIntegrity: "sha512-new",
        tarballShasum: "newsum",
        analyserVersion: result.report.analyserVersion
      }))?.action
    ).toBe("block");
    const auditEvents = await persistence.listAuditEvents();
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "anvil-worker",
        eventType: "analysis.completed",
        targetId: "pkg@1.0.1"
      }),
      expect.objectContaining({
        actor: "anvil-worker",
        eventType: "policy.decision",
        targetId: "pkg@1.0.1",
        metadata: expect.objectContaining({
          source: "analysis",
          action: "block",
          policyVersion: config.policy.version,
          analyserVersion: result.report.analyserVersion,
          tarballIntegrity: "sha512-new",
          tarballShasum: "newsum",
          reasonCodes: expect.arrayContaining(["NEW_INSTALL_SCRIPT", "UNSAFE_TARBALL_SYMLINK"])
        })
      })
    ]));
  });

  it("analyses queued jobs", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "1.0.1",
        reason: "metadata_request",
        priority: "normal",
        createdAt: new Date().toISOString()
      },
      { config, registry, persistence }
    );

    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(registry.fetchTarball).toHaveBeenCalledTimes(2);
  });

  it("persists low-adoption name-squatting signals in worker reports", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => typoMetadata()),
      fetchTarball: vi.fn(async (url: string) => tarballs[url])
    };

    const result = await analysePackageTarget("@tenstack/react-query@1.0.0", {
      config,
      registry,
      persistence,
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 10)
      }
    });

    const codes = result.report.signals.map((signal) => signal.code);
    expect(codes).toContain("LOW_WEEKLY_DOWNLOADS");
    expect(codes).toContain("SIMILAR_TO_POPULAR_PACKAGE");
    expect(result.report.signals.find((signal) => signal.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({
      severity: "critical",
      evidence: { candidate: "@tanstack/react-query" }
    });
    expect(
      (await persistence.getPolicyDecision("@tenstack/react-query", "1.0.0", config.policy.version, {
        tarballIntegrity: "sha512-typo",
        tarballShasum: "typosum",
        analyserVersion: result.report.analyserVersion
      }))?.action
    ).toBe("block");
  });

  it("quarantines high-download packages without provenance metadata", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => popularMetadataWithoutProvenance()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("popular-package@1.0.0", {
      config,
      registry,
      persistence,
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 250_000)
      }
    });

    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_MISSING",
        severity: "medium",
        evidence: expect.objectContaining({ weeklyDownloads: 250_000, threshold: config.policy.provenance.highDownloadThreshold })
      })
    );
    expect(result.report.provenance).toEqual({
      status: "missing",
      target: { present: false },
      previous: undefined,
      verification: expect.objectContaining({
        status: "missing",
        verified: false,
        expectedSubjectName: "popular-package@1.0.0"
      })
    });
    expect(result.decision.action).toBe("quarantine");
    expect(registry.fetchTarball).not.toHaveBeenCalled();
  });

  it("quarantines package versions whose provenance metadata changes", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => provenanceChangedMetadata()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("provenance-pkg@1.0.1", {
      config,
      registry,
      persistence,
      provenanceVerifier: new MetadataProvenanceVerifier()
    });

    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_CHANGED",
        severity: "medium",
        evidence: {
          previous: {
            present: true,
            source: "dist.attestations",
            attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
          },
          target: {
            present: true,
            source: "dist.attestations",
            attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
          }
        }
      })
    );
    expect(result.report.provenance).toMatchObject({
      status: "changed",
      previous: {
        present: true,
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
      },
      target: {
        present: true,
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
      }
    });
    expect(result.decision.action).toBe("quarantine");
  });

  it("blocks package versions whose provenance subject does not match the analysed package", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => provenanceSubjectMismatchMetadata()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("subject-pkg@1.0.0", {
      config,
      registry,
      persistence
    });

    expect(result.report.provenance?.verification).toMatchObject({
      status: "subject_mismatch",
      verified: false,
      subjectName: "other-pkg@1.0.0",
      expectedSubjectName: "subject-pkg@1.0.0"
    });
    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_SUBJECT_MISMATCH",
        severity: "high"
      })
    );
    expect(result.decision.action).toBe("block");
  });
});

const tarballs: Record<string, Uint8Array> = {
  "https://registry.example/pkg/-/pkg-1.0.0.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "pkg", version: "1.0.0" })
    }
  ]),
  "https://registry.example/pkg/-/pkg-1.0.1.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "pkg", version: "1.0.1" })
    },
    {
      path: "package/install.js",
      content: "require('child_process').execSync('node ./postinstall.js')"
    },
    {
      path: "package/link-out",
      type: "symlink",
      linkTarget: "../../outside"
    }
  ]),
  "https://registry.example/@tenstack/react-query/-/react-query-1.0.0.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "@tenstack/react-query", version: "1.0.0" })
    }
  ])
};

function metadata(): NpmPackageMetadata {
  return {
    name: "pkg",
    "dist-tags": { latest: "1.0.1" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "pkg",
        version: "1.0.0",
        dist: {
          tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
          integrity: "sha512-old",
          shasum: "oldsum"
        },
        dependencies: {},
        peerDependencies: { react: "^18.0.0" },
        repository: { type: "git", url: "https://example.test/pkg.git" }
      },
      "1.0.1": {
        name: "pkg",
        version: "1.0.1",
        dist: {
          tarball: "https://registry.example/pkg/-/pkg-1.0.1.tgz",
          integrity: "sha512-new",
          shasum: "newsum"
        },
        scripts: {
          install: "node install.js"
        },
        dependencies: {
          "tiny-left-pad": "^1.0.0"
        },
        optionalDependencies: {
          fsevents: "^2.0.0"
        },
        peerDependencies: {
          react: "^19.0.0"
        },
        bin: {
          pkg: "./cli.js"
        },
        repository: { type: "git", url: "https://example.test/pkg-renamed.git" }
      }
    }
  };
}

function typoMetadata(): NpmPackageMetadata {
  return {
    name: "@tenstack/react-query",
    "dist-tags": { latest: "1.0.0" },
    time: {
      created: "2020-01-01T00:00:00.000Z",
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "@tenstack/react-query",
        version: "1.0.0",
        dist: {
          tarball: "https://registry.example/@tenstack/react-query/-/react-query-1.0.0.tgz",
          integrity: "sha512-typo",
          shasum: "typosum"
        }
      }
    }
  };
}

function popularMetadataWithoutProvenance(): NpmPackageMetadata {
  return {
    name: "popular-package",
    "dist-tags": { latest: "1.0.0" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "popular-package",
        version: "1.0.0",
        dist: {
          integrity: "sha512-popular",
          shasum: "popularsum"
        }
      }
    }
  };
}

function provenanceChangedMetadata(): NpmPackageMetadata {
  return {
    name: "provenance-pkg",
    "dist-tags": { latest: "1.0.1" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "provenance-pkg",
        version: "1.0.0",
        dist: {
          attestations: {
            url: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
          }
        }
      },
      "1.0.1": {
        name: "provenance-pkg",
        version: "1.0.1",
        dist: {
          attestations: {
            url: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
          }
        }
      }
    }
  };
}

function provenanceSubjectMismatchMetadata(): NpmPackageMetadata {
  return {
    name: "subject-pkg",
    "dist-tags": { latest: "1.0.0" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "subject-pkg",
        version: "1.0.0",
        dist: {
          integrity: "sha512-expected",
          attestations: {
            subject: {
              name: "other-pkg@1.0.0",
              digest: { sha512: "different" }
            }
          }
        }
      }
    }
  };
}

function makeTarball(entries: Array<{ path: string; content?: string; mode?: number; type?: "file" | "symlink"; linkTarget?: string }>): Uint8Array {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, entry.mode ?? 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.type === "symlink" ? 0 : content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(" ", 148, 156);
    header.write(entry.type === "symlink" ? "2" : "0", 156, 1, "utf8");
    if (entry.linkTarget) header.write(entry.linkTarget, 157, 100, "utf8");
    header.write("ustar", 257, 6, "utf8");

    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeOctal(header, checksum, 148, 8);

    blocks.push(header);
    if (entry.type !== "symlink") blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const valueText = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${valueText}\0`, offset, length, "ascii");
}
