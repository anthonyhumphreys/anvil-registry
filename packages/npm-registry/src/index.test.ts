import { afterEach, describe, expect, it, vi } from "vitest";
import { NpmDownloadsClient, encodePackagePath, toVersionMetadata } from "./index.js";

describe("npm registry helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes scoped package metadata paths without collapsing the slash", () => {
    expect(encodePackagePath("@scope/pkg")).toBe("%40scope/pkg");
  });

  it("fetches weekly download counts from the npm downloads API", async () => {
    const fetch = vi.fn(async () => Response.json({ downloads: 42 }));
    vi.stubGlobal("fetch", fetch);

    const client = new NpmDownloadsClient({ baseUrl: "https://api.npmjs.org/downloads/" });
    await expect(client.getWeeklyDownloads("@scope/pkg")).resolves.toBe(42);

    expect(fetch).toHaveBeenCalledWith("https://api.npmjs.org/downloads/point/last-week/%40scope%2Fpkg");
  });

  it("treats missing download stats as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const client = new NpmDownloadsClient({ baseUrl: "https://api.npmjs.org/downloads" });

    await expect(client.getWeeklyDownloads("private-ish")).resolves.toBeUndefined();
  });

  it("maps npm provenance attestations from version metadata", () => {
    const version = toVersionMetadata(
      {
        name: "pkg",
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0",
            dist: {
              tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
              attestations: {
                url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
              }
            }
          }
        }
      },
      "1.0.0"
    );

    expect(version?.provenance).toEqual({
      present: true,
      source: "dist.attestations",
      attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0",
      raw: {
        url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
      }
    });
  });

  it("marks provenance as absent when npm metadata has no provenance fields", () => {
    const version = toVersionMetadata(
      {
        name: "pkg",
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0"
          }
        }
      },
      "1.0.0"
    );

    expect(version?.provenance).toEqual({ present: false });
  });

  it("preserves the package private flag from npm version metadata", () => {
    const version = toVersionMetadata(
      {
        name: "@scope/private-pkg",
        versions: {
          "1.0.0": {
            name: "@scope/private-pkg",
            version: "1.0.0",
            private: true
          }
        }
      },
      "1.0.0"
    );

    expect(version?.private).toBe(true);
  });
});
