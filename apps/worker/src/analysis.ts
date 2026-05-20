import semver from "semver";
import type { AnvilConfig } from "@anvil/config";
import { detectNameSquatting } from "@anvil/name-squatting";
import type { NpmRegistryClient } from "@anvil/npm-registry";
import { calculatePackageAgeDays, toVersionMetadata } from "@anvil/npm-registry";
import { analyseFileTree, analyseManifestChange, mergeAnalysisReports, parseNpmTarball } from "@anvil/package-analysis";
import type { AnvilPersistence } from "@anvil/persistence";
import { evaluatePolicy } from "@anvil/policy-engine";
import { FetchingProvenanceVerifier, type ProvenanceVerifier } from "@anvil/provenance";
import { buildPolicyDecisionAuditEvent, type AnalysisJob, type AnalysisReport, type PackageVersionMetadata, type PolicyReason } from "@anvil/shared";

export type WorkerAnalysisDependencies = {
  config: AnvilConfig;
  registry: Pick<NpmRegistryClient, "fetchMetadata" | "fetchTarball">;
  persistence: AnvilPersistence;
  downloadStats?: {
    getWeeklyDownloads(packageName: string): Promise<number | undefined>;
  };
  provenanceVerifier?: ProvenanceVerifier;
};

export async function analysePackageTarget(target: string, dependencies: WorkerAnalysisDependencies) {
  const parsed = parsePackageTarget(target);
  return analysePackageVersion({ packageName: parsed.packageName, version: parsed.version }, dependencies);
}

export async function analyseAnalysisJob(job: AnalysisJob, dependencies: WorkerAnalysisDependencies) {
  return analysePackageVersion({ packageName: job.packageName, version: job.version }, dependencies);
}

async function analysePackageVersion(target: { packageName: string; version: string }, dependencies: WorkerAnalysisDependencies) {
  const metadata = await dependencies.registry.fetchMetadata(target.packageName);
  const version = target.version === "latest" ? metadata["dist-tags"]?.latest : target.version;
  if (!version) throw new Error(`Cannot resolve version for ${target.packageName}@${target.version}`);

  const versions = Object.keys(metadata.versions ?? {}).filter((candidate) => semver.valid(candidate));
  const previousVersions = semver.rsort(versions.filter((candidate) => semver.lt(candidate, version))).slice(0, dependencies.config.policy.comparePreviousVersions);
  const previousVersion = previousVersions[0];
  const targetMetadata = toVersionMetadata(metadata, version);
  if (!targetMetadata) throw new Error(`Version metadata not found for ${target.packageName}@${version}`);

  const previousMetadata = previousVersion ? toVersionMetadata(metadata, previousVersion) : undefined;
  const provenanceVerifier = dependencies.provenanceVerifier ?? new FetchingProvenanceVerifier();
  const provenanceVerification = await provenanceVerifier.verify({
    packageName: target.packageName,
    version,
    integrity: targetMetadata.integrity,
    shasum: targetMetadata.shasum,
    provenance: targetMetadata.provenance
  });
  const manifestReport = analyseManifestChange(targetMetadata, previousMetadata, {
    analyserVersion: "manifest-2026-05-20.1",
    policyVersion: dependencies.config.policy.version
  });
  const staticReport = targetMetadata.tarballUrl
    ? mergeAnalysisReports(
        manifestReport,
        analyseFileTree(
          parseNpmTarball(await dependencies.registry.fetchTarball(targetMetadata.tarballUrl)),
          await Promise.all(
            previousVersions
              .map((baselineVersion) => toVersionMetadata(metadata, baselineVersion)?.tarballUrl)
              .filter((tarballUrl): tarballUrl is string => Boolean(tarballUrl))
              .map(async (tarballUrl) => parseNpmTarball(await dependencies.registry.fetchTarball(tarballUrl)))
          ),
          { lifecycleScripts: targetMetadata.scripts }
        )
      )
    : manifestReport;
  const weeklyDownloads = await dependencies.downloadStats?.getWeeklyDownloads(target.packageName);
  const report = mergePolicyContextSignals(
    {
      ...staticReport,
      tarballIntegrity: targetMetadata.integrity,
      tarballShasum: targetMetadata.shasum,
      provenance: summarizeReportProvenance(targetMetadata, previousMetadata, provenanceVerification)
    },
    {
      weeklyDownloads,
      packageAgeDays: calculatePackageAgeDays(targetMetadata.publishedAt),
      similarPackages: detectNameSquatting(target.packageName).map((signal) => ({
        name: signal.candidate,
        similarity: signal.similarity,
        weeklyDownloads: signal.weeklyDownloads,
        reasons: signal.reasons
      })),
      targetMetadata,
      previousMetadata,
      policy: dependencies.config.policy
    }
  );

  await dependencies.persistence.putAnalysisReport(report);
  const decision = evaluatePolicy({
    packageName: target.packageName,
    version,
    runtimeMode: dependencies.config.RUNTIME_MODE,
    analysisReport: report,
    override: await dependencies.persistence.getOverride(target.packageName, version),
    policy: dependencies.config.policy
  });
  const decisionIdentity = {
    tarballIntegrity: targetMetadata.integrity,
    tarballShasum: targetMetadata.shasum,
    analyserVersion: report.analyserVersion
  };
  await dependencies.persistence.putPolicyDecision(target.packageName, version, dependencies.config.policy.version, decision, decisionIdentity);
  await dependencies.persistence.putAuditEvent(buildPolicyDecisionAuditEvent({
    actor: "anvil-worker",
    source: "analysis",
    packageName: target.packageName,
    version,
    policyVersion: dependencies.config.policy.version,
    decision,
    identity: decisionIdentity
  }));
  await dependencies.persistence.putAuditEvent({
    actor: "anvil-worker",
    eventType: "analysis.completed",
    targetType: "package",
    targetId: `${target.packageName}@${version}`,
    metadata: {
      action: decision.action,
      score: decision.score,
      analyserVersion: report.analyserVersion,
      policyVersion: dependencies.config.policy.version,
      signalCount: report.signals.length
    }
  });

  return { report, decision, packageName: target.packageName, version };
}

export function parsePackageTarget(target: string): { packageName: string; version: string } {
  const atIndex = target.startsWith("@") ? target.lastIndexOf("@") : target.indexOf("@");
  if (atIndex <= 0) return { packageName: target, version: "latest" };
  return { packageName: target.slice(0, atIndex), version: target.slice(atIndex + 1) };
}

function mergePolicyContextSignals(
  report: AnalysisReport,
  context: {
    weeklyDownloads?: number;
    packageAgeDays?: number;
    similarPackages: Array<{ name: string; similarity: number; weeklyDownloads?: number; reasons: string[] }>;
    targetMetadata: PackageVersionMetadata;
    previousMetadata?: PackageVersionMetadata;
    policy: AnvilConfig["policy"];
  }
): AnalysisReport {
  const signals: PolicyReason[] = [...report.signals];

  if (typeof context.packageAgeDays === "number" && context.packageAgeDays < context.policy.minimumPackageAgeDays) {
    signals.push({
      code: "PACKAGE_TOO_NEW",
      message:
        context.packageAgeDays < 1
          ? "Package version was published less than 1 day ago."
          : `Package version is newer than the ${context.policy.minimumPackageAgeDays} day policy window.`,
      severity: context.packageAgeDays < 1 ? "critical" : "high",
      evidence: { packageAgeDays: context.packageAgeDays }
    });
  }

  if (typeof context.weeklyDownloads === "number" && context.weeklyDownloads < context.policy.lowDownloadThreshold) {
    signals.push({
      code: "LOW_WEEKLY_DOWNLOADS",
      message: "Package has fewer weekly downloads than the configured threshold.",
      severity: context.weeklyDownloads < context.policy.strictLowDownloadThreshold ? "high" : "medium",
      evidence: { weeklyDownloads: context.weeklyDownloads, threshold: context.policy.lowDownloadThreshold }
    });
  }

  const bestSimilarPackage = context.similarPackages[0];
  if (bestSimilarPackage && bestSimilarPackage.similarity >= 0.82) {
    const lowAdoption = typeof context.weeklyDownloads === "number" && context.weeklyDownloads < context.policy.lowDownloadThreshold;
    signals.push({
      code: "SIMILAR_TO_POPULAR_PACKAGE",
      message: `Package name is similar to ${bestSimilarPackage.name}.`,
      severity: lowAdoption && context.policy.blockSimilarLowDownloadPackages ? "critical" : "medium",
      evidence: {
        candidate: bestSimilarPackage.name,
        similarity: bestSimilarPackage.similarity,
        weeklyDownloads: bestSimilarPackage.weeklyDownloads,
        reasons: bestSimilarPackage.reasons
      }
    });
  }

  if (
    typeof context.weeklyDownloads === "number" &&
    context.weeklyDownloads < context.policy.lowDownloadThreshold &&
    typeof context.packageAgeDays === "number" &&
    context.packageAgeDays < context.policy.minimumPackageAgeDays
  ) {
    signals.push({
      code: "NEW_PACKAGE_LOW_DOWNLOADS",
      message: "Package is both new and low-adoption.",
      severity: "high",
      evidence: { weeklyDownloads: context.weeklyDownloads, packageAgeDays: context.packageAgeDays }
    });
  }

  if (context.policy.provenance.enabled) {
    signals.push(...detectProvenanceSignals(context));
    if (report.provenance?.verification?.status === "subject_mismatch") {
      signals.push({
        code: "PROVENANCE_SUBJECT_MISMATCH",
        message: "Provenance attestation subject does not match the analysed package identity.",
        severity: "high",
        evidence: report.provenance.verification.evidence
      });
    }
  }

  return {
    ...report,
    signals,
    score: scoreSignals(signals)
  };
}

function detectProvenanceSignals(context: {
  weeklyDownloads?: number;
  targetMetadata: PackageVersionMetadata;
  previousMetadata?: PackageVersionMetadata;
  policy: AnvilConfig["policy"];
}): PolicyReason[] {
  const targetProvenance = context.targetMetadata.provenance;
  const previousProvenance = context.previousMetadata?.provenance;
  const previousHadProvenance = previousProvenance?.present === true;
  const targetHasProvenance = targetProvenance?.present === true;

  if (previousHadProvenance && !targetHasProvenance) {
    return [
      {
        code: "PROVENANCE_MISSING",
        message: "Package provenance was present on the previous version but is missing on this version.",
        severity: "high",
        evidence: { previous: summarizeProvenance(previousProvenance), target: summarizeProvenance(targetProvenance) }
      }
    ];
  }

  if (previousHadProvenance && targetHasProvenance && provenanceChanged(previousProvenance, targetProvenance)) {
    return [
      {
        code: "PROVENANCE_CHANGED",
        message: "Package provenance metadata changed compared with the previous version.",
        severity: "medium",
        evidence: { previous: summarizeProvenance(previousProvenance), target: summarizeProvenance(targetProvenance) }
      }
    ];
  }

  if (
    !targetHasProvenance &&
    typeof context.weeklyDownloads === "number" &&
    context.weeklyDownloads >= context.policy.provenance.highDownloadThreshold
  ) {
    return [
      {
        code: "PROVENANCE_MISSING",
        message: "High-download package has no published provenance metadata.",
        severity: "medium",
        evidence: {
          weeklyDownloads: context.weeklyDownloads,
          threshold: context.policy.provenance.highDownloadThreshold,
          provenancePresent: false
        }
      }
    ];
  }

  return [];
}

function provenanceChanged(
  previous: NonNullable<PackageVersionMetadata["provenance"]>,
  target: NonNullable<PackageVersionMetadata["provenance"]>
) {
  return previous.source !== target.source || previous.attestationUrl !== target.attestationUrl;
}

function summarizeReportProvenance(
  targetMetadata: PackageVersionMetadata,
  previousMetadata: PackageVersionMetadata | undefined,
  verification: NonNullable<AnalysisReport["provenance"]>["verification"]
): AnalysisReport["provenance"] {
  const target = targetMetadata.provenance;
  const previous = previousMetadata?.provenance;

  if (previous?.present === true && target?.present !== true) {
    return { status: "removed", previous, target, verification };
  }

  if (previous?.present === true && target?.present === true && provenanceChanged(previous, target)) {
    return { status: "changed", previous, target, verification };
  }

  if (target?.present === true) {
    return { status: "present", previous, target, verification };
  }

  return { status: "missing", previous, target, verification };
}

function summarizeProvenance(provenance: PackageVersionMetadata["provenance"]) {
  if (!provenance) return { present: false };
  return {
    present: provenance.present,
    source: provenance.source,
    attestationUrl: provenance.attestationUrl
  };
}

function scoreSignals(signals: PolicyReason[]) {
  return signals.reduce(
    (total, signal) =>
      total + (signal.severity === "critical" ? 95 : signal.severity === "high" ? 70 : signal.severity === "medium" ? 35 : signal.severity === "low" ? 10 : 0),
    0
  );
}
