import { z } from "zod";
import type { LlmRiskReview } from "@anvil/shared";

export const llmRiskTypeSchema = z.enum([
  "typosquatting",
  "dependency_confusion",
  "credential_exfiltration",
  "install_script_abuse",
  "obfuscation",
  "unexpected_network_access",
  "suspicious_maintainer_change",
  "overbroad_dependency_tree",
  "unknown"
]);

export const llmEvidenceSourceSchema = z.enum(["metadata", "package_json", "diff", "code_snippet", "download_stats"]);

export const llmRiskReviewSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  suspectedRiskTypes: z.array(llmRiskTypeSchema),
  evidence: z.array(
    z.object({
      signal: z.string(),
      explanation: z.string(),
      source: llmEvidenceSourceSchema
    })
  ),
  recommendedAction: z.enum(["allow", "warn", "quarantine", "block"])
}) satisfies z.ZodType<LlmRiskReview>;

export interface LlmRiskReviewProvider {
  review(input: unknown): Promise<LlmRiskReview | undefined>;
}

export class DisabledLlmRiskReviewProvider implements LlmRiskReviewProvider {
  async review(): Promise<undefined> {
    return undefined;
  }
}
