import { describe, expect, it } from "vitest";
import { buildPolicyDecisionAuditEvent, resolveOverrideExpiry } from "./index.js";

describe("buildPolicyDecisionAuditEvent", () => {
  it("builds the shared policy decision audit event shape", () => {
    expect(
      buildPolicyDecisionAuditEvent({
        actor: "anvil-worker",
        source: "analysis",
        packageName: "@scope/pkg",
        version: "1.0.0",
        policyVersion: "policy-v1",
        decision: {
          action: "block",
          score: 95,
          explanation: "blocked",
          reasons: [{ code: "NEW_INSTALL_SCRIPT", message: "install script", severity: "high" }]
        },
        identity: {
          tarballIntegrity: "sha512-test",
          tarballShasum: "abc123",
          analyserVersion: "static-v1"
        }
      })
    ).toEqual({
      actor: "anvil-worker",
      eventType: "policy.decision",
      targetType: "package",
      targetId: "@scope/pkg@1.0.0",
      metadata: {
        source: "analysis",
        action: "block",
        score: 95,
        policyVersion: "policy-v1",
        analyserVersion: "static-v1",
        tarballIntegrity: "sha512-test",
        tarballShasum: "abc123",
        reasonCodes: ["NEW_INSTALL_SCRIPT"]
      }
    });
  });
});

describe("resolveOverrideExpiry", () => {
  it("normalizes explicit expiry timestamps", () => {
    expect(resolveOverrideExpiry("2026-06-20T00:00:00Z", 30)).toBe("2026-06-20T00:00:00.000Z");
  });

  it("applies the configured default expiry when no explicit timestamp is provided", () => {
    expect(resolveOverrideExpiry(undefined, 30, Date.parse("2026-05-20T00:00:00.000Z"))).toBe("2026-06-19T00:00:00.000Z");
  });

  it("rejects invalid explicit expiry timestamps", () => {
    expect(resolveOverrideExpiry("next whenever-ish", 30)).toBeNull();
  });
});
