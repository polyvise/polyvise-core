import type { EvidenceSource, TopicKind } from "../debate/types";
import { loadDebateRuntimeConfig, type DebateRuntimeConfig, type EvidenceProviderName } from "../debate/config";

export interface EvidenceProvider {
  name: string;
  search(subject: string, topicKind: TopicKind): Promise<EvidenceSource[]>;
}

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  profile?: { name?: string };
  age?: string;
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
};

export class BraveEvidenceProvider implements EvidenceProvider {
  name = "brave";

  constructor(private readonly apiKey = process.env.BRAVE_SEARCH_API_KEY) {}

  async search(subject: string, topicKind: TopicKind): Promise<EvidenceSource[]> {
    if (!this.apiKey) {
      return [];
    }

    const query = encodeURIComponent(`${subject} evidence analysis ${topicKind}`);
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${query}&count=8`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey
      }
    });

    if (!response.ok) {
      throw new EvidenceSearchError(`Brave Search failed with ${response.status}`, response.status);
    }

    const payload = (await response.json()) as { web?: { results?: BraveWebResult[] } };

    return (payload.web?.results ?? [])
      .filter((result): result is Required<Pick<BraveWebResult, "title" | "url">> & BraveWebResult =>
        Boolean(result.title && result.url)
      )
      .map((result, index) => ({
        id: `src-live-${index + 1}`,
        title: result.title,
        url: result.url,
        publisher: result.profile?.name ?? new URL(result.url).hostname.replace(/^www\./, ""),
        publishedAt: result.age,
        snippet: result.description ?? "Search result selected as contextual evidence.",
        quality: inferSourceQuality(result.url),
        retrievedVia: "brave",
        status: "accepted"
      }));
  }
}

export class TavilyEvidenceProvider implements EvidenceProvider {
  name = "tavily";

  constructor(private readonly apiKey = process.env.TAVILY_API_KEY) {}

  async search(subject: string, topicKind: TopicKind): Promise<EvidenceSource[]> {
    if (!this.apiKey) {
      return [];
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `${subject} evidence analysis ${topicKind}`,
        search_depth: "basic",
        max_results: 8,
        include_answer: false,
        include_raw_content: false
      })
    });

    if (!response.ok) {
      throw new EvidenceSearchError(`Tavily Search failed with ${response.status}`, response.status);
    }

    const payload = (await response.json()) as { results?: TavilySearchResult[] };

    return (payload.results ?? [])
      .filter((result): result is Required<Pick<TavilySearchResult, "title" | "url">> & TavilySearchResult =>
        Boolean(result.title && result.url)
      )
      .map((result, index) => ({
        id: `src-tavily-${index + 1}`,
        title: result.title,
        url: result.url,
        publisher: new URL(result.url).hostname.replace(/^www\./, ""),
        publishedAt: result.published_date,
        snippet: result.content ?? "Search result selected as contextual evidence.",
        quality: inferSourceQuality(result.url),
        retrievedVia: "tavily",
        status: "accepted"
      }));
  }
}

export class MockEvidenceProvider implements EvidenceProvider {
  name = "mock";

  async search(subject: string, topicKind: TopicKind): Promise<EvidenceSource[]> {
    const catalog = selectMockCatalog(subject, topicKind);

    return catalog.map((source, index) => ({
      id: `src-mock-${index + 1}`,
      retrievedVia: "mock",
      status: "accepted",
      ...source
    }));
  }
}

export type EvidenceCollectionResult = {
  sources: EvidenceSource[];
  diagnostic?: string;
};

export async function collectEvidence(
  subject: string,
  topicKind: TopicKind,
  configOrProvider: DebateRuntimeConfig | EvidenceProviderName = loadDebateRuntimeConfig()
): Promise<EvidenceSource[]> {
  return (await collectEvidenceWithDiagnostics(subject, topicKind, configOrProvider)).sources;
}

export async function collectEvidenceWithDiagnostics(
  subject: string,
  topicKind: TopicKind,
  configOrProvider: DebateRuntimeConfig | EvidenceProviderName = loadDebateRuntimeConfig()
): Promise<EvidenceCollectionResult> {
  const config =
    typeof configOrProvider === "string"
      ? { ...loadDebateRuntimeConfig(), evidenceProvider: configOrProvider }
      : configOrProvider;
  const preferredProvider = config.evidenceProvider;

  if (preferredProvider === "mock") {
    if (!config.allowDeterministicFallbacks) {
      throw new Error("Live evidence search is required.");
    }
    return {
      sources: await new MockEvidenceProvider().search(subject, topicKind),
      diagnostic: "Configured evidence provider is mock."
    };
  }

  const provider = preferredProvider === "tavily" ? new TavilyEvidenceProvider() : new BraveEvidenceProvider();
  const missingKey = missingEvidenceApiKey(preferredProvider);
  let diagnostic = missingKey
    ? `${provider.name} evidence search skipped because ${missingKey} is not configured.`
    : undefined;

  try {
    const live = await searchWithRetry(provider, subject, topicKind, config);
    if (live.length > 0) {
      return { sources: normalizeSources(live).slice(0, 8) };
    }
    diagnostic = `${provider.name} evidence search returned no usable sources.`;
  } catch (error) {
    if (!config.allowDeterministicFallbacks) {
      throw error;
    }
    diagnostic = `${provider.name} evidence search failed: ${formatDiagnosticError(error)}`;
    // Fall through to deterministic references so local development remains reliable.
  }

  if (!config.allowDeterministicFallbacks) {
    throw new Error("Live evidence search did not return usable sources.");
  }

  return {
    sources: await new MockEvidenceProvider().search(subject, topicKind),
    diagnostic
  };
}

async function searchWithRetry(
  provider: EvidenceProvider,
  subject: string,
  topicKind: TopicKind,
  config: DebateRuntimeConfig
): Promise<EvidenceSource[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.llmMaxAttempts; attempt += 1) {
    try {
      return await provider.search(subject, topicKind);
    } catch (error) {
      lastError = error;
      if (attempt >= config.llmMaxAttempts || !isRetriableSearchError(error)) {
        break;
      }
      await delay(config.apiRetryBaseDelayMs * attempt);
    }
  }

  throw lastError;
}

class EvidenceSearchError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function isRetriableSearchError(error: unknown): boolean {
  if (error instanceof EvidenceSearchError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }

  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingEvidenceApiKey(provider: EvidenceProviderName): string | null {
  if (provider === "brave" && !process.env.BRAVE_SEARCH_API_KEY) {
    return "BRAVE_SEARCH_API_KEY";
  }
  if (provider === "tavily" && !process.env.TAVILY_API_KEY) {
    return "TAVILY_API_KEY";
  }
  return null;
}

function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown provider error";
}

export function normalizeSources(sources: EvidenceSource[]): EvidenceSource[] {
  const seen = new Set<string>();
  const normalized: EvidenceSource[] = [];

  for (const source of sources) {
    const key = source.url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      ...source,
      title: source.title.trim(),
      publisher: source.publisher.trim(),
      snippet: source.snippet.trim(),
      status: source.status === "rejected" ? "needs_review" : source.status
    });
  }

  return normalized;
}

function inferSourceQuality(url: string): EvidenceSource["quality"] {
  const hostname = new URL(url).hostname;
  if (/\.(gov|edu)$/.test(hostname) || hostname.includes("who.int") || hostname.includes("oecd.org")) {
    return "primary";
  }
  if (hostname.includes("openai.com") || hostname.includes("mit.edu") || hostname.includes("nature.com")) {
    return "expert";
  }
  return "context";
}

function selectMockCatalog(subject: string, topicKind: TopicKind): Omit<EvidenceSource, "id" | "retrievedVia" | "status">[] {
  const text = subject.toLowerCase();

  if (text.includes("nuclear")) {
    return [
      {
        title: "Nuclear Power in a Clean Energy System",
        url: "https://www.iea.org/reports/nuclear-power-in-a-clean-energy-system",
        publisher: "International Energy Agency",
        snippet: "Analyzes nuclear power's role in reliability, emissions reduction, and energy system planning.",
        quality: "expert"
      },
      {
        title: "AR6 Synthesis Report: Climate Change 2023",
        url: "https://www.ipcc.ch/report/ar6/syr/",
        publisher: "IPCC",
        snippet: "Summarizes mitigation pathways, technology tradeoffs, and climate-risk evidence.",
        quality: "primary"
      }
    ];
  }

  if (text.includes("remote") || text.includes("hybrid")) {
    return [
      {
        title: "How Hybrid Working From Home Works Out",
        url: "https://www.nber.org/papers/w30292",
        publisher: "National Bureau of Economic Research",
        snippet: "Reports evidence on hybrid work outcomes, retention, productivity, and employee preferences.",
        quality: "expert"
      },
      {
        title: "Work Trend Index",
        url: "https://www.microsoft.com/en-us/worklab/work-trend-index",
        publisher: "Microsoft WorkLab",
        snippet: "Surveys work patterns and management tradeoffs in hybrid and remote work.",
        quality: "context"
      }
    ];
  }

  if (text.includes("school") && text.includes("phone")) {
    return [
      {
        title: "Global Education Monitoring Report 2023",
        url: "https://www.unesco.org/gem-report/en/technology",
        publisher: "UNESCO",
        snippet: "Reviews education technology tradeoffs, distraction risks, and policy considerations.",
        quality: "expert"
      },
      {
        title: "Student Mobile Phone Use in Schools",
        url: "https://www.oecd.org/education/",
        publisher: "OECD",
        snippet: "Provides education-system context for student technology policies and outcomes.",
        quality: "context"
      }
    ];
  }

  if (text.includes("ai") || text.includes("model") || text.includes("automation")) {
    return [
      {
        title: "Artificial Intelligence Risk Management Framework",
        url: "https://www.nist.gov/itl/ai-risk-management-framework",
        publisher: "NIST",
        snippet: "Defines risk-management practices for trustworthy AI systems.",
        quality: "primary"
      },
      {
        title: "Business Blog: AI and the claims you make",
        url: "https://www.ftc.gov/business-guidance/blog/2023/02/keep-your-ai-claims-check",
        publisher: "Federal Trade Commission",
        snippet: "Warns businesses to substantiate AI claims and consider consumer protection risks.",
        quality: "primary"
      }
    ];
  }

  return [
    {
      title: "Kialo Edu: Argument Mapping",
      url: "https://www.kialo-edu.com/advantages",
      publisher: "Kialo",
      snippet: "Shows how argument trees help users inspect supporting and opposing reasons.",
      quality: "methodology"
    },
    {
      title: "Modified Oxford-Style Debate Format",
      url: "https://www.uscourts.gov/about-federal-courts/educational-resources/about-educational-outreach/activity-resources/oxford-style-debate",
      publisher: "United States Courts",
      snippet: "Outlines opening arguments, rebuttals, and audience-oriented debate structure.",
      quality: "methodology"
    },
    {
      title: "AI Safety via Debate",
      url: "https://openai.com/index/debate/",
      publisher: "OpenAI",
      snippet: "Explains adversarial debate as a way to expose weaknesses in model-generated answers.",
      quality: "methodology"
    },
    {
      title: "Multi-AI Collaboration Helps Reasoning and Factual Accuracy",
      url: "https://news.mit.edu/2023/multi-ai-collaboration-helps-reasoning-factual-accuracy-language-models-0918",
      publisher: "MIT News",
      snippet: "Covers research showing multiple AI agents can improve reasoning through collaboration.",
      quality: "expert"
    },
    {
      title: "Citizens' Assembly",
      url: "https://democracyinstitute.osu.edu/citizens-assembly",
      publisher: "Ohio State Democracy Institute",
      snippet: "Describes deliberative assembly practices for weighing diverse perspectives.",
      quality: "methodology"
    },
    {
      title: `Evidence search placeholder for ${topicKind} topics`,
      url: "https://example.com/evidence-provider-required",
      publisher: "Internal reference",
      snippet:
        "Configure BRAVE_SEARCH_API_KEY to replace this development reference with live topic-specific source retrieval.",
      quality: "context"
    }
  ];
}
