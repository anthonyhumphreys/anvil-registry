import { describe, expect, it } from "vitest";
import { DisabledLlmRiskReviewProvider, llmRiskReviewSchema } from "./index.js";

describe("llmRiskReviewSchema", () => {
  it("accepts spec-shaped structured risk reviews", () => {
    const review = llmRiskReviewSchema.parse({
      riskLevel: "high",
      confidence: "medium",
      summary: "Install script reaches out to a raw content host and reads token-looking environment variables.",
      suspectedRiskTypes: ["install_script_abuse", "credential_exfiltration", "unexpected_network_access"],
      evidence: [
        {
          signal: "NETWORK_ACCESS_IN_INSTALL_PATH",
          explanation: "The install path calls out to a remote host during dependency installation.",
          source: "code_snippet"
        },
        {
          signal: "USES_PROCESS_ENV",
          explanation: "The script reads process.env while running as an install hook.",
          source: "package_json"
        }
      ],
      recommendedAction: "quarantine"
    });

    expect(review.suspectedRiskTypes).toContain("credential_exfiltration");
    expect(review.evidence[0]?.source).toBe("code_snippet");
  });

  it("rejects non-spec risk types and evidence sources", () => {
    const result = llmRiskReviewSchema.safeParse({
      riskLevel: "high",
      confidence: "high",
      summary: "Looks spicy, allegedly.",
      suspectedRiskTypes: ["vibe_based_malware"],
      evidence: [{ signal: "UNKNOWN", explanation: "Because the model said so.", source: "horoscope" }],
      recommendedAction: "block"
    });

    expect(result.success).toBe(false);
  });

  it("keeps LLM review disabled by default", async () => {
    await expect(new DisabledLlmRiskReviewProvider().review()).resolves.toBeUndefined();
  });
});
