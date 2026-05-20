import { describe, expect, it } from "vitest";
import { loadConfig, resolveDatabaseUrl } from "./index.js";

describe("config", () => {
  it("prefers explicit DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://explicit.example/anvil" })).toBe("postgres://explicit.example/anvil");
  });

  it("builds a Postgres URL from discrete database environment values", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_HOST: "db.example.test",
        DATABASE_PORT: 5433,
        DATABASE_NAME: "anvil",
        DATABASE_USER: "anvil",
        DATABASE_PASSWORD: "p@ss word"
      })
    ).toBe("postgres://anvil:p%40ss%20word@db.example.test:5433/anvil");
  });

  it("loads SQS and database settings together for AWS services", () => {
    const config = loadConfig({
      ...process.env,
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_HOST: "db.example.test",
      DATABASE_NAME: "anvil",
      DATABASE_USER: "anvil",
      DATABASE_PASSWORD: "secret",
      QUEUE_DRIVER: "sqs",
      ANALYSIS_QUEUE_URL: "https://sqs.example.test/queue"
    });

    expect(config.DATABASE_URL).toBe("postgres://anvil:secret@db.example.test:5432/anvil");
    expect(config.QUEUE_DRIVER).toBe("sqs");
  });

  it("loads the optional popular package index path", () => {
    const config = loadConfig({
      ...process.env,
      POPULAR_PACKAGE_INDEX_PATH: "/etc/anvil/popular-index/npm/latest.json",
      POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/2026-05-20.json"
    });

    expect(config.POPULAR_PACKAGE_INDEX_PATH).toBe("/etc/anvil/popular-index/npm/latest.json");
    expect(config.POPULAR_PACKAGE_INDEX_OBJECT_KEY).toBe("popular-index/npm/2026-05-20.json");
  });

  it("loads LLM review policy from environment flags", () => {
    const config = loadConfig({
      ...process.env,
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "http",
      LLM_REVIEW_MODEL: "risk-reviewer",
      LLM_REVIEW_ENDPOINT: "https://llm.example.test/review",
      LLM_REVIEW_API_KEY: "secret",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true",
      LLM_REVIEW_RUN_ON_QUARANTINE: "true",
      LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: "false"
    });

    expect(config.policy.llmReview).toEqual({
      enabled: true,
      includePrivatePackages: false,
      runOnUnknownPackages: true,
      runOnQuarantine: true,
      provider: "http",
      model: "risk-reviewer"
    });
    expect(config.LLM_REVIEW_ENDPOINT).toBe("https://llm.example.test/review");
    expect(config.LLM_REVIEW_API_KEY).toBe("secret");
  });
});
