import { describe, expect, it } from "vitest";
import { getAvailableModel, getAvailableModels } from "../src/models/catalog";

describe("model catalog", () => {
  it("returns unique OpenRouter model ids with normalized metadata", () => {
    const models = getAvailableModels();

    expect(models.length).toBeGreaterThan(10);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(models.every((model) => model.id.includes("/"))).toBe(true);
    expect(models.every((model) => model.label && model.provider && model.tier)).toBe(true);
  });

  it("returns defensive copies", () => {
    const models = getAvailableModels();
    models[0]!.label = "changed";

    expect(getAvailableModels()[0]!.label).not.toBe("changed");
  });

  it("finds a known model and rejects an unknown model", () => {
    expect(getAvailableModel("anthropic/claude-sonnet-5")?.label).toBe("Claude Sonnet 5");
    expect(getAvailableModel("unknown/model")).toBeUndefined();
  });
});
