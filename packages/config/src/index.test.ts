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
});
