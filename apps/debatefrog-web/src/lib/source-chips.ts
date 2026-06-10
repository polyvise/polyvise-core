import type { EvidenceSource } from "@polyvise/debate-engine/debate/types";

export type FroglingsSourceChip = {
  id: string;
  label: string;
  url: string;
};

export function buildFroglingsSourceChips(
  sourceIds: string[],
  sources: EvidenceSource[],
  limit = 2
): FroglingsSourceChip[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const chips: FroglingsSourceChip[] = [];
  const seen = new Set<string>();

  for (const sourceId of sourceIds) {
    if (chips.length >= limit) break;
    const source = sourceById.get(sourceId);
    if (!source || shouldHideFroglingsSource(source)) continue;
    const urlKey = source.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(urlKey)) continue;
    seen.add(urlKey);
    chips.push({
      id: source.id,
      label: sourceChipLabel(source),
      url: source.url
    });
  }

  return chips;
}

export function shouldHideFroglingsSource(source: EvidenceSource): boolean {
  const normalizedTitle = source.title.toLowerCase();
  const normalizedPublisher = source.publisher.toLowerCase();

  if (source.status !== "accepted") return true;
  if (!/^https?:\/\//.test(source.url)) return true;
  if (source.url.includes("example.com/evidence-provider-required")) return true;
  if (normalizedTitle.includes("evidence search placeholder")) return true;
  if (normalizedPublisher.includes("internal reference")) return true;
  if (source.retrievedVia === "mock" && isGenericMockMethodSource(source)) return true;

  return source.retrievedVia === "mock" && source.quality === "methodology";
}

function isGenericMockMethodSource(source: EvidenceSource): boolean {
  const normalized = `${source.title} ${source.url} ${source.publisher}`.toLowerCase();

  return (
    normalized.includes("kialo") ||
    normalized.includes("oxford-style debate") ||
    normalized.includes("openai.com/index/debate") ||
    normalized.includes("multi-ai collaboration") ||
    normalized.includes("citizens' assembly") ||
    normalized.includes("democracyinstitute.osu.edu")
  );
}

function sourceChipLabel(source: EvidenceSource): string {
  const publisher = source.publisher.trim();
  if (publisher && !publisher.toLowerCase().includes("internal reference")) {
    return trimSourceLabel(publisher);
  }

  return trimSourceLabel(source.title);
}

function trimSourceLabel(value: string): string {
  const cleaned = value
    .replace(/^www\./i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= 28) return cleaned;
  const slice = cleaned.slice(0, 28).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 12 ? lastSpace : 28).replace(/[,:;.-]+$/, "")}...`;
}
