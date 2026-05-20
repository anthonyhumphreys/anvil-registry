import { defaultPolicyConfig } from "@anvil/config";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./index.js";

describe("evaluatePolicy", () => {
  it("blocks very new packages", () => {
    const decision = evaluatePolicy({
      packageName: "leftpadder",
      version: "1.0.0",
      runtimeMode: "ci",
      packageAgeDays: 0.5,
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.map((reason) => reason.code)).toContain("PACKAGE_TOO_NEW");
  });

  it("blocks low-download similar packages", () => {
    const decision = evaluatePolicy({
      packageName: "@tenstack/react-query",
      version: "1.0.0",
      runtimeMode: "development",
      weeklyDownloads: 10,
      similarPackages: [{ name: "@tanstack/react-query", similarity: 0.95, weeklyDownloads: 4_000_000 }],
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
  });

  it("honours active allow overrides", () => {
    const decision = evaluatePolicy({
      packageName: "fresh-package",
      version: "1.0.0",
      runtimeMode: "ci",
      packageAgeDays: 0,
      override: {
        packageName: "fresh-package",
        version: "1.0.0",
        action: "allow",
        reason: "Approved for test fixture"
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("allow");
  });

  it("blocks tarballs with unsafe extraction entries", () => {
    const decision = evaluatePolicy({
      packageName: "haunted-tarball",
      version: "1.0.0",
      runtimeMode: "development",
      analysisReport: {
        packageName: "haunted-tarball",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "UNSAFE_TARBALL_SYMLINK", message: "Tarball contains a symlink pointing outside the package.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.map((reason) => reason.code)).toContain("UNSAFE_TARBALL_SYMLINK");
  });

  it("quarantines large file size deltas outside development", () => {
    const decision = evaluatePolicy({
      packageName: "chunky-patch",
      version: "1.0.1",
      runtimeMode: "ci",
      analysisReport: {
        packageName: "chunky-patch",
        version: "1.0.1",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "LARGE_FILE_SIZE_DELTA", message: "File size grew sharply compared with previous package versions.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
  });

  it("quarantines missing provenance signals outside development", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_MISSING", message: "High-download package has no published provenance metadata.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
  });

  it("enforces missing provenance for high-download packages during metadata policy", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: false }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_MISSING",
        evidence: expect.objectContaining({ weeklyDownloads: 250_000, provenancePresent: false })
      })
    );
  });

  it("allows high-download packages with provenance when no other risk is present", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations", attestationUrl: "https://registry.example/attestations/popular-package" }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("allow");
  });

  it("reduces risk score when trusted publishing metadata is present", () => {
    const decision = evaluatePolicy({
      packageName: "low-adoption-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 500,
      versionMetadata: {
        name: "low-adoption-package",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations", attestationUrl: "https://registry.example/attestations/low-adoption-package" }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("warn");
    expect(decision.score).toBe(25);
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "TRUSTED_PUBLISHING_PRESENT",
        evidence: expect.objectContaining({ scoreReduction: defaultPolicyConfig.provenance.trustedPublishingScoreReduction })
      })
    );
  });

  it("does not let trusted publishing metadata bypass hard blocks", () => {
    const decision = evaluatePolicy({
      packageName: "haunted-tarball",
      version: "1.0.0",
      runtimeMode: "ci",
      versionMetadata: {
        name: "haunted-tarball",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations" }
      },
      analysisReport: {
        packageName: "haunted-tarball",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "UNSAFE_TARBALL_PATH", message: "Tarball contains an unsafe path.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
  });

  it("deduplicates provenance reasons when metadata and analysis report agree", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: false }
      },
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_MISSING", message: "High-download package has no published provenance metadata.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.reasons.filter((reason) => reason.code === "PROVENANCE_MISSING")).toHaveLength(1);
  });

  it("warns on changed provenance signals in development", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.1",
      runtimeMode: "development",
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.1",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_CHANGED", message: "Package provenance metadata changed compared with the previous version.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("warn");
  });
});
