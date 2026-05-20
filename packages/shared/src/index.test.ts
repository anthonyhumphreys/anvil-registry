import { describe, expect, it } from "vitest";
import { buildPolicyDecisionAuditEvent } from "./index.js";

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
