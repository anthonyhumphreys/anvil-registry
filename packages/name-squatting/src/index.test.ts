import { describe, expect, it } from "vitest";
import { detectNameSquatting, jaroWinklerSimilarity } from "./index.js";

describe("detectNameSquatting", () => {
  it("detects tanstack confusion", () => {
    expect(detectNameSquatting("@tenstack/react-query")[0]).toMatchObject({
      candidate: "@tanstack/react-query",
      suggestedPackage: "@tanstack/react-query",
      reasons: expect.arrayContaining(["known_ecosystem_confusion"])
    });
  });

  it("detects lodash typo", () => {
    expect(detectNameSquatting("loadash")[0]).toMatchObject({
      candidate: "lodash",
      reasons: expect.arrayContaining(["known_ecosystem_confusion"])
    });
  });

  it("detects vite scope confusion", () => {
    expect(detectNameSquatting("@vite/plugin-react")[0]).toMatchObject({
      candidate: "@vitejs/plugin-react",
      reasons: expect.arrayContaining(["known_ecosystem_confusion", "similar_scope"])
    });
  });

  it("labels edit-pattern variants", () => {
    const missing = detectNameSquatting("lodsh", [{ name: "lodash" }])[0];
    const extra = detectNameSquatting("loadash", [{ name: "lodash" }])[0];
    const transposed = detectNameSquatting("lodahs", [{ name: "lodash" }])[0];

    expect(missing?.reasons).toContain("missing_character");
    expect(extra?.reasons).toContain("extra_character");
    expect(transposed?.reasons).toContain("transposed_characters");
  });

  it("labels pluralisation and visual variants", () => {
    expect(detectNameSquatting("reacts", [{ name: "react" }])[0]?.reasons).toContain("pluralisation_variant");
    expect(detectNameSquatting("l0dash", [{ name: "lodash" }])[0]?.reasons).toContain("visual_similarity");
  });

  it("uses Jaro-Winkler similarity as an additional signal", () => {
    expect(jaroWinklerSimilarity("fastfy", "fastify")).toBeGreaterThan(0.9);
    expect(detectNameSquatting("fastfy", [{ name: "fastify" }])[0]?.reasons).toContain("high_jaro_winkler_similarity");
  });
});
