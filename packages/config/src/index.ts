import { z } from "zod";
import { type PolicyConfig, runtimeModeSchema } from "@anvil/shared";

const envSchema = z.object({
  RUNTIME_MODE: runtimeModeSchema.default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4873),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4873"),
  UPSTREAM_NPM_REGISTRY: z.string().url().default("https://registry.npmjs.org"),
  NPM_DOWNLOADS_API: z.string().url().default("https://api.npmjs.org/downloads"),
  CACHE_DIR: z.string().default(".anvil/cache"),
  PERSISTENCE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().optional(),
  DATABASE_HOST: z.string().optional(),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().optional(),
  DATABASE_USER: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  QUEUE_DRIVER: z.enum(["memory", "bullmq", "sqs"]).default("memory"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ANALYSIS_QUEUE_NAME: z.string().default("anvil-analysis"),
  ANALYSIS_QUEUE_URL: z.string().url().optional(),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  OBJECT_STORE_DRIVER: z.enum(["file", "s3"]).default("file"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default("anvil-package-cache"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  ADMIN_TOKEN: z.string().optional()
});

export type AnvilConfig = ReturnType<typeof loadConfig>;

export const defaultPolicyConfig: PolicyConfig = {
  version: "2026-05-20.1",
  minimumPackageAgeDays: 7,
  comparePreviousVersions: 3,
  lowDownloadThreshold: 1000,
  strictLowDownloadThreshold: 100,
  blockSimilarLowDownloadPackages: true,
  blockNewInstallScripts: true,
  quarantineChangedInstallScripts: true,
  blockUnexpectedBinaries: true,
  quarantineObfuscatedCode: true,
  hideQuarantinedMetadata: true,
  provenance: {
    enabled: true,
    highDownloadThreshold: 100_000,
    trustedPublishingScoreReduction: 10,
    quarantineChangedProvenance: true,
    quarantineMissingForHighDownloadPackages: true
  },
  overrides: {
    enabled: true,
    requireReason: true,
    defaultExpiryDays: 30
  },
  llmReview: {
    enabled: false,
    includePrivatePackages: false,
    runOnUnknownPackages: false,
    runOnQuarantine: false
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const databaseUrl = resolveDatabaseUrl(parsed);

  return {
    ...parsed,
    DATABASE_URL: databaseUrl,
    policy: defaultPolicyConfig
  };
}

export function resolveDatabaseUrl(env: {
  DATABASE_URL?: string;
  DATABASE_HOST?: string;
  DATABASE_PORT?: number;
  DATABASE_NAME?: string;
  DATABASE_USER?: string;
  DATABASE_PASSWORD?: string;
}): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.DATABASE_HOST || !env.DATABASE_NAME || !env.DATABASE_USER || env.DATABASE_PASSWORD === undefined) return undefined;

  const url = new URL("postgres://localhost");
  url.hostname = env.DATABASE_HOST;
  url.port = String(env.DATABASE_PORT ?? 5432);
  url.pathname = `/${env.DATABASE_NAME}`;
  url.username = env.DATABASE_USER;
  url.password = env.DATABASE_PASSWORD;
  return url.toString();
}
