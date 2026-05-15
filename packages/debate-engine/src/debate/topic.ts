import type { HighStakesNotice, TopicKind } from "./types";

const policyTerms = [
  "ban",
  "law",
  "regulate",
  "require",
  "policy",
  "government",
  "tax",
  "mandate",
  "cities",
  "schools",
  "public"
];

const valueTerms = ["ethical", "moral", "right", "wrong", "fair", "justice", "good", "bad", "better"];
const decisionTerms = ["should i", "should we", "my company", "our team", "choose", "adopt", "buy", "switch"];
const comparisonTerms = [" vs ", " versus ", "compared with", "compare", "between"];
const empiricalTerms = ["is it true", "does", "will", "can", "cause", "evidence", "effective"];

export function classifyTopic(subject: string, context = ""): TopicKind {
  const text = `${subject} ${context}`.toLowerCase();

  if (comparisonTerms.some((term) => text.includes(term))) {
    return "comparison";
  }

  if (decisionTerms.some((term) => text.includes(term))) {
    return "decision";
  }

  if (policyTerms.some((term) => text.includes(term))) {
    return "policy";
  }

  if (valueTerms.some((term) => text.includes(term))) {
    return "value";
  }

  if (empiricalTerms.some((term) => text.includes(term))) {
    return "empirical";
  }

  return subject.trim().endsWith("?") ? "decision" : "value";
}

export function frameResolution(subject: string, topicKind: TopicKind): string {
  const cleanSubject = subject.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  const lower = cleanSubject.toLowerCase();

  if (lower.startsWith("resolved:")) {
    return cleanSubject;
  }

  if (lower.startsWith("should ")) {
    return `Resolved: ${cleanSubject.charAt(0).toUpperCase()}${cleanSubject.slice(1)}.`;
  }

  if (topicKind === "comparison") {
    return `Resolved: The better choice is ${cleanSubject}.`;
  }

  if (topicKind === "empirical") {
    return `Resolved: The available evidence supports the claim that ${cleanSubject}.`;
  }

  if (topicKind === "value") {
    return `Resolved: ${cleanSubject} is defensible when judged against practical and ethical tradeoffs.`;
  }

  return `Resolved: Decision-makers should pursue ${cleanSubject}.`;
}

export function detectHighStakes(subject: string, context = ""): HighStakesNotice | null {
  const text = `${subject} ${context}`.toLowerCase();

  if (/(diagnos|medicine|medical|therapy|therapist|surgery|symptom|cancer|drug|dose|suicide|self-harm)/.test(text)) {
    return {
      category: "medical",
      message:
        "Polyvise can organize considerations, but this is not medical advice. Consult a qualified clinician for health decisions."
    };
  }

  if (/(lawsuit|lawyer|legal|contract|criminal|immigration|divorce|custody|compliance)/.test(text)) {
    return {
      category: "legal",
      message:
        "Polyvise can map issues, but this is not legal advice. Consult a qualified attorney for legal decisions."
    };
  }

  if (/(invest|portfolio|stock|tax|retirement|loan|mortgage|insurance|financial)/.test(text)) {
    return {
      category: "financial",
      message:
        "Polyvise can compare tradeoffs, but this is not financial advice. Consult a qualified professional before acting."
    };
  }

  if (/(weapon|violence|hazard|emergency|danger|explosive|security incident)/.test(text)) {
    return {
      category: "safety",
      message:
        "Polyvise can support non-operational risk framing, but it should not be used for dangerous or emergency decisions."
    };
  }

  return null;
}
