import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { LOCAL_BROWSER_PRESENTATION_JAVASCRIPT } from "../../../../src/infrastructure/http/local-browser-presentation-assets.js";

describe("local browser presentation assets", () => {
  it("exports JavaScript that parses as the exact served source", () => {
    expect(() => new Script(LOCAL_BROWSER_PRESENTATION_JAVASCRIPT)).not.toThrow();
  });
});
