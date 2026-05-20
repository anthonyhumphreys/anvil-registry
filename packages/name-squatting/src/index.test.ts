import { describe, expect, it } from "vitest";
import { detectNameSquatting } from "./index.js";

describe("detectNameSquatting", () => {
  it("detects tanstack confusion", () => {
    expect(detectNameSquatting("@tenstack/react-query")[0]?.candidate).toBe("@tanstack/react-query");
  });

  it("detects lodash typo", () => {
    expect(detectNameSquatting("loadash")[0]?.candidate).toBe("lodash");
  });

  it("detects vite scope confusion", () => {
    expect(detectNameSquatting("@vite/plugin-react")[0]?.candidate).toBe("@vitejs/plugin-react");
  });
});
