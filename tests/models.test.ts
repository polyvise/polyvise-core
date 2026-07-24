import { describe, expect, it } from "vitest";
import {
  getAvailableModel,
  getAvailableModels,
  getKnownModel,
  getKnownModels
} from "../src/models/catalog";

describe("model catalog", () => {
  it("returns unique OpenRouter model ids with normalized metadata", () => {
    const models = getAvailableModels();

    expect(models.length).toBeGreaterThan(10);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    expect(models.every((model) => model.id.includes("/"))).toBe(true);
    expect(models.every((model) => model.label && model.provider && model.tier)).toBe(true);
    expect(models.every((model) => model.compatibility === "supported")).toBe(true);
  });

  it("returns defensive copies", () => {
    const models = getAvailableModels();
    models[0]!.label = "changed";

    expect(getAvailableModels()[0]!.label).not.toBe("changed");
  });

  it("keeps incompatible models known but out of the available catalog", () => {
    expect(getAvailableModel("openai/gpt-5.5")?.label).toBe("GPT-5.5");
    expect(getAvailableModel("moonshotai/kimi-k3")).toBeUndefined();
    expect(getKnownModel("moonshotai/kimi-k3")?.compatibility).toBe("experimental");
    expect(getKnownModels()).toHaveLength(15);
    expect(getAvailableModel("unknown/model")).toBeUndefined();
  });
});
