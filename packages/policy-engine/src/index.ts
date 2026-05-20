import type { PolicyDecision, PolicyInput, PolicyReason } from "@anvil/shared";

const severityScore = {
  info: 0,
  low: 10,
  medium: 35,
  high: 70,
  critical: 95
} as const;

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const reasons: PolicyReason[] = [];

  const activeOverride = resolveActiveOverride(input);
  if (activeOverride) {
    return {
      action: activeOverride.action,
      score: activeOverride.action === "allow" ? 0 : 80,
      reasons: [
        {
          code: "APPROVED_OVERRIDE",
          message: activeOverride.reason,
          severity: "info",
          evidence: { approvedBy: activeOverride.approvedBy, expiresAt: activeOverride.expiresAt }
        }
      ],
      explanation: `Override applies to ${input.packageName}@${input.version}.`,
      expiresAt: activeOverride.expiresAt
    };
  }

  if (typeof input.packageAgeDays === "number" && input.packageAgeDays < input.policy.minimumPackageAgeDays) {
    const lessThanOneDay = input.packageAgeDays < 1;
    reasons.push({
      code: "PACKAGE_TOO_NEW",
      message: lessThanOneDay
        ? "Package version was published less than 1 day ago."
        : `Package version is newer than the ${input.policy.minimumPackageAgeDays} day policy window.`,
      severity: lessThanOneDay ? "critical" : input.runtimeMode === "development" ? "medium" : "high",
      evidence: { packageAgeDays: input.packageAgeDays }
    });
  }

  if (typeof input.weeklyDownloads === "number" && input.weeklyDownloads < input.policy.lowDownloadThreshold) {
    reasons.push({
      code: "LOW_WEEKLY_DOWNLOADS",
      message: "Package has fewer weekly downloads than the configured threshold.",
      severity: input.weeklyDownloads < input.policy.strictLowDownloadThreshold ? "high" : "medium",
      evidence: { weeklyDownloads: input.weeklyDownloads, threshold: input.policy.lowDownloadThreshold }
    });
  }

  const bestSimilarPackage = input.similarPackages?.[0];
  if (bestSimilarPackage && bestSimilarPackage.similarity >= 0.82) {
    reasons.push({
      code: "SIMILAR_TO_POPULAR_PACKAGE",
      message: `Package name is similar to ${bestSimilarPackage.name}.`,
      severity: input.policy.blockSimilarLowDownloadPackages ? "critical" : "medium",
      evidence: { candidate: bestSimilarPackage.name, similarity: bestSimilarPackage.similarity }
    });
  }

  if (
    typeof input.weeklyDownloads === "number" &&
    input.weeklyDownloads < input.policy.lowDownloadThreshold &&
    typeof input.packageAgeDays === "number" &&
    input.packageAgeDays < input.policy.minimumPackageAgeDays
  ) {
    reasons.push({
      code: "NEW_PACKAGE_LOW_DOWNLOADS",
      message: "Package is both new and low-adoption.",
      severity: "high",
      evidence: { weeklyDownloads: input.weeklyDownloads, packageAgeDays: input.packageAgeDays }
    });
  }

  const provenancePolicy = input.policy.provenance;
  if (
    provenancePolicy?.enabled !== false &&
    input.versionMetadata?.provenance?.present !== true &&
    typeof input.weeklyDownloads === "number" &&
    provenancePolicy &&
    input.weeklyDownloads >= provenancePolicy.highDownloadThreshold
  ) {
    reasons.push({
      code: "PROVENANCE_MISSING",
      message: "High-download package has no published provenance metadata.",
      severity: "medium",
      evidence: {
        weeklyDownloads: input.weeklyDownloads,
        threshold: provenancePolicy.highDownloadThreshold,
        provenancePresent: false
      }
    });
  }

  if (provenancePolicy?.enabled !== false && input.versionMetadata?.provenance?.present === true) {
    reasons.push({
      code: "TRUSTED_PUBLISHING_PRESENT",
      message: "Package version has published provenance metadata.",
      severity: "info",
      evidence: {
        source: input.versionMetadata.provenance.source,
        attestationUrl: input.versionMetadata.provenance.attestationUrl,
        scoreReduction: provenancePolicy?.trustedPublishingScoreReduction ?? 0
      }
    });
  }

  for (const signal of input.analysisReport?.signals ?? []) {
    if (!reasons.some((reason) => reason.code === signal.code && reason.message === signal.message)) reasons.push(signal);
  }

  if (input.llmRiskReview && ["high", "critical"].includes(input.llmRiskReview.riskLevel)) {
    reasons.push({
      code: "LLM_RISK_REVIEW_FLAGGED",
      message: input.llmRiskReview.summary,
      severity: input.llmRiskReview.riskLevel,
      evidence: { confidence: input.llmRiskReview.confidence }
    });
  }

  const score = scorePolicyReasons(input, reasons);
  const action = decideAction(input, reasons, score);

  return {
    action,
    score,
    reasons,
    explanation: explainDecision(input.packageName, input.version, action, reasons)
  };
}

function scorePolicyReasons(input: PolicyInput, reasons: PolicyReason[]) {
  const rawScore = Math.min(100, reasons.reduce((total, reason) => total + severityScore[reason.severity], 0));
  const trustedPublishingPresent = reasons.some((reason) => reason.code === "TRUSTED_PUBLISHING_PRESENT");
  const provenanceRisk = reasons.some((reason) => reason.code === "PROVENANCE_CHANGED" || reason.code === "PROVENANCE_MISSING");
  if (!trustedPublishingPresent || provenanceRisk) return rawScore;
  return Math.max(0, rawScore - (input.policy.provenance?.trustedPublishingScoreReduction ?? 0));
}

function resolveActiveOverride(input: PolicyInput) {
  if (!input.policy.overrides.enabled || !input.override) return undefined;
  if (input.override.version && input.override.version !== input.version) return undefined;
  if (input.override.expiresAt && Date.parse(input.override.expiresAt) < Date.now()) return undefined;
  return input.override;
}

function decideAction(input: PolicyInput, reasons: PolicyReason[], score: number): PolicyDecision["action"] {
  if (reasons.some((reason) => reason.severity === "critical")) return "block";
  if (reasons.some((reason) => reason.code === "PACKAGE_TOO_NEW" && input.packageAgeDays !== undefined && input.packageAgeDays < 1)) {
    return "block";
  }
  if (reasons.some((reason) => reason.code === "LOW_WEEKLY_DOWNLOADS") && reasons.some((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE")) {
    return input.policy.blockSimilarLowDownloadPackages ? "block" : "quarantine";
  }
  if (reasons.some((reason) => reason.code === "NEW_INSTALL_SCRIPT") && input.policy.blockNewInstallScripts) return "block";
  if (reasons.some((reason) => reason.code === "UNEXPECTED_BINARY_FILE") && input.policy.blockUnexpectedBinaries) return "block";
  if (reasons.some((reason) => reason.code === "UNSAFE_TARBALL_PATH" || reason.code === "UNSAFE_TARBALL_SYMLINK")) return "block";
  if (reasons.some((reason) => reason.code === "INSTALL_SCRIPT_CHANGED") && input.policy.quarantineChangedInstallScripts) return "quarantine";
  if (reasons.some((reason) => reason.code === "OBFUSCATED_CODE_DETECTED") && input.policy.quarantineObfuscatedCode) return "quarantine";
  if (reasons.some((reason) => reason.code === "LARGE_FILE_SIZE_DELTA")) return input.runtimeMode === "development" ? "warn" : "quarantine";
  if (reasons.some((reason) => reason.code === "PROVENANCE_CHANGED") && input.policy.provenance?.quarantineChangedProvenance !== false) {
    return input.runtimeMode === "development" ? "warn" : "quarantine";
  }
  if (reasons.some((reason) => reason.code === "PROVENANCE_MISSING") && input.policy.provenance?.quarantineMissingForHighDownloadPackages !== false) {
    return input.runtimeMode === "development" ? "warn" : "quarantine";
  }
  if (score >= 70) return input.runtimeMode === "development" ? "quarantine" : "block";
  if (score >= 35) return input.runtimeMode === "development" ? "warn" : "quarantine";
  if (score > 0) return "warn";
  return "allow";
}

function explainDecision(packageName: string, version: string, action: PolicyDecision["action"], reasons: PolicyReason[]) {
  if (action === "allow") return `${packageName}@${version} is allowed by deterministic policy.`;
  const reasonText = reasons.map((reason) => reason.message).join(" ");
  return `${packageName}@${version} is ${action}ed by deterministic policy. ${reasonText}`;
}
