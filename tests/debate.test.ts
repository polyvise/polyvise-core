import { describe, expect, it } from "vitest";
import { runHybridCouncilDebate } from "@/lib/debate/engine";
import { debateRequestSchema } from "@/lib/debate/schema";
import { classifyTopic, detectHighStakes, frameResolution } from "@/lib/debate/topic";
import { normalizeSources } from "@/lib/providers/search";
import type { EvidenceSource } from "@/lib/debate/types";

describe("topic framing", () => {
  it("classifies personal and organizational decisions", () => {
    expect(classifyTopic("Should my company adopt AI customer support this year?")).toBe("decision");
  });

  it("frames direct should questions as neutral resolutions", () => {
    expect(frameResolution("Should schools allow phones during the day?", "policy")).toBe(
      "Resolved: Should schools allow phones during the day."
    );
  });

  it("flags high-stakes topics", () => {
    expect(detectHighStakes("Should I change my medication dose?")?.category).toBe("medical");
    expect(detectHighStakes("Should I invest my retirement portfolio in a single stock?")?.category).toBe("financial");
  });
});

describe("source normalization", () => {
  it("deduplicates sources by URL and trims fields", () => {
    const sources: EvidenceSource[] = [
      {
        id: "a",
        title: " Source A ",
        url: "https://example.com/report/",
        publisher: " Example ",
        snippet: " Snippet ",
        quality: "expert",
        retrievedVia: "mock",
        status: "accepted"
      },
      {
        id: "b",
        title: "Source A Duplicate",
        url: "https://example.com/report",
        publisher: "Example",
        snippet: "Duplicate",
        quality: "expert",
        retrievedVia: "mock",
        status: "accepted"
      }
    ];

    expect(normalizeSources(sources)).toHaveLength(1);
    expect(normalizeSources(sources)[0].title).toBe("Source A");
  });
});

describe("request schema", () => {
  it("rejects underspecified subjects", () => {
    expect(debateRequestSchema.safeParse({ subject: "AI" }).success).toBe(false);
  });

  it("defaults to the v1 debate settings", () => {
    const parsed = debateRequestSchema.parse({ subject: "Should cities ban private cars downtown?" });
    expect(parsed.mode).toBe("hybrid_council");
    expect(parsed.evidence).toBe("cited");
  });
});

describe("hybrid council engine", () => {
  it("produces a complete cited debate run", async () => {
    const run = await runHybridCouncilDebate("debate_test", {
      subject: "Should a small company adopt AI customer support this year?"
    });

    expect(run.status).toBe("complete");
    expect(run.scouts).toHaveLength(5);
    expect(run.teams.pro).toHaveLength(2);
    expect(run.teams.con).toHaveLength(2);
    expect(run.sources.length).toBeGreaterThanOrEqual(2);
    expect(run.claims.filter((claim) => claim.side === "pro")).toHaveLength(3);
    expect(run.claims.filter((claim) => claim.side === "con")).toHaveLength(3);
    expect(run.turns.map((turn) => turn.round)).toContain("cross_examination");
    expect(run.summary.whatWouldChangeMind.length).toBeGreaterThan(0);
  });
});
