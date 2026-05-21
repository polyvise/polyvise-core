import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { debateRecords, userFeedback } from "../db/schema";
import type { DebateRecord, UserFeedback } from "./types";

export interface DebateRepository {
  save(debate: DebateRecord): Promise<void>;
  get(id: string): Promise<DebateRecord | null>;
  list(): Promise<DebateRecord[]>;
}

export interface FeedbackRepository {
  save(feedback: UserFeedback): Promise<void>;
  list(): Promise<UserFeedback[]>;
}

type MemoryRepositoryState = {
  debates: Map<string, DebateRecord>;
  feedback: Map<string, UserFeedback>;
};

const globalForRepository = globalThis as typeof globalThis & {
  __polyviseDebateRepository?: MemoryRepositoryState;
};

function getMemoryRepositoryState(): MemoryRepositoryState {
  const state =
    globalForRepository.__polyviseDebateRepository ??
    (globalForRepository.__polyviseDebateRepository = {
      debates: new Map(),
      feedback: new Map()
    });

  state.feedback ??= new Map();
  return state;
}

export class MemoryDebateRepository implements DebateRepository {
  private readonly state: MemoryRepositoryState;

  constructor(state = getMemoryRepositoryState()) {
    this.state = state;
  }

  async save(debate: DebateRecord): Promise<void> {
    this.state.debates.set(debate.id, debate);
  }

  async get(id: string): Promise<DebateRecord | null> {
    return this.state.debates.get(id) ?? null;
  }

  async list(): Promise<DebateRecord[]> {
    return Array.from(this.state.debates.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class MemoryFeedbackRepository implements FeedbackRepository {
  private readonly state: MemoryRepositoryState;

  constructor(state = getMemoryRepositoryState()) {
    this.state = state;
  }

  async save(feedback: UserFeedback): Promise<void> {
    this.state.feedback.set(feedback.id, feedback);
  }

  async list(): Promise<UserFeedback[]> {
    return Array.from(this.state.feedback.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class PostgresDebateRepository implements DebateRepository {
  async save(debate: DebateRecord): Promise<void> {
    const now = new Date(debate.updatedAt);
    await getDb()
      .insert(debateRecords)
      .values({
        id: debate.id,
        record: debate,
        createdAt: new Date(debate.createdAt),
        updatedAt: Number.isNaN(now.getTime()) ? new Date() : now
      })
      .onConflictDoUpdate({
        target: debateRecords.id,
        set: {
          record: debate,
          updatedAt: Number.isNaN(now.getTime()) ? new Date() : now
        }
      });
  }

  async get(id: string): Promise<DebateRecord | null> {
    const rows = await getDb().select().from(debateRecords).where(eq(debateRecords.id, id)).limit(1);
    return (rows[0]?.record as DebateRecord | undefined) ?? null;
  }

  async list(): Promise<DebateRecord[]> {
    const rows = await getDb().select().from(debateRecords).orderBy(desc(debateRecords.updatedAt)).limit(50);
    return rows.map((row) => row.record as DebateRecord);
  }
}

export class PostgresFeedbackRepository implements FeedbackRepository {
  async save(feedback: UserFeedback): Promise<void> {
    await getDb()
      .insert(userFeedback)
      .values({
        id: feedback.id,
        app: feedback.app,
        message: feedback.message,
        debateId: feedback.debateId,
        pagePath: feedback.pagePath,
        userAgent: feedback.userAgent,
        metadata: feedback.metadata,
        createdAt: new Date(feedback.createdAt)
      });
  }

  async list(): Promise<UserFeedback[]> {
    const rows = await getDb().select().from(userFeedback).orderBy(desc(userFeedback.createdAt)).limit(100);
    return rows.map((row) => ({
      id: row.id,
      app: row.app,
      message: row.message,
      debateId: row.debateId ?? undefined,
      pagePath: row.pagePath ?? undefined,
      userAgent: row.userAgent ?? undefined,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt.toISOString()
    }));
  }
}

type FirestoreToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedFirestoreToken: FirestoreToken | null = null;

export class FirestoreDebateRepository implements DebateRepository {
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly collection = "debate_records";

  constructor(
    projectId =
      process.env.FIRESTORE_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT_ID ??
      "",
    databaseId = process.env.FIRESTORE_DATABASE_ID ?? "(default)"
  ) {
    if (!projectId) {
      throw new Error("FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required for Firestore persistence.");
    }

    this.projectId = projectId;
    this.databaseId = databaseId;
  }

  async save(debate: DebateRecord): Promise<void> {
    await this.request(`documents/${this.collection}/${encodeURIComponent(debate.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          recordJson: { stringValue: JSON.stringify(debate) },
          createdAt: { timestampValue: debate.createdAt },
          updatedAt: { timestampValue: debate.updatedAt }
        }
      })
    });
  }

  async get(id: string): Promise<DebateRecord | null> {
    const response = await this.request(`documents/${this.collection}/${encodeURIComponent(id)}`, {
      method: "GET",
      allowNotFound: true
    });

    if (!response) {
      return null;
    }

    return parseFirestoreDebate(response);
  }

  async list(): Promise<DebateRecord[]> {
    const query = new URLSearchParams({
      pageSize: "50",
      orderBy: "updatedAt desc"
    });
    const response = await this.request(`documents/${this.collection}?${query}`, {
      method: "GET"
    });

    if (!response) {
      return [];
    }

    return ((response.documents ?? []) as unknown[]).flatMap((document) => {
      const debate = parseFirestoreDebate(document);
      return debate ? [debate] : [];
    });
  }

  private async request(
    path: string,
    options: RequestInit & { allowNotFound?: boolean }
  ): Promise<Record<string, unknown> | null> {
    const token = await getFirestoreAccessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/${this.databaseId}/${path}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );

    if (options.allowNotFound && response.status === 404) {
      return null;
    }

    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Firestore request failed with ${response.status}.`);
    }

    return payload as Record<string, unknown>;
  }
}

export class FirestoreFeedbackRepository implements FeedbackRepository {
  private readonly projectId: string;
  private readonly databaseId: string;
  private readonly collection = "user_feedback";

  constructor(
    projectId =
      process.env.FIRESTORE_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT_ID ??
      "",
    databaseId = process.env.FIRESTORE_DATABASE_ID ?? "(default)"
  ) {
    if (!projectId) {
      throw new Error("FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required for Firestore persistence.");
    }

    this.projectId = projectId;
    this.databaseId = databaseId;
  }

  async save(feedback: UserFeedback): Promise<void> {
    await firestoreRequest(this.projectId, this.databaseId, `documents/${this.collection}/${encodeURIComponent(feedback.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          app: { stringValue: feedback.app },
          message: { stringValue: feedback.message },
          debateId: { stringValue: feedback.debateId ?? "" },
          pagePath: { stringValue: feedback.pagePath ?? "" },
          userAgent: { stringValue: feedback.userAgent ?? "" },
          metadataJson: { stringValue: JSON.stringify(feedback.metadata) },
          createdAt: { timestampValue: feedback.createdAt }
        }
      })
    });
  }

  async list(): Promise<UserFeedback[]> {
    const query = new URLSearchParams({
      pageSize: "100",
      orderBy: "createdAt desc"
    });
    const response = await firestoreRequest(
      this.projectId,
      this.databaseId,
      `documents/${this.collection}?${query}`,
      { method: "GET" }
    );

    if (!response) {
      return [];
    }

    return ((response.documents ?? []) as unknown[]).flatMap((document) => {
      const feedback = parseFirestoreFeedback(document);
      return feedback ? [feedback] : [];
    });
  }
}

export function createDefaultDebateRepository(): DebateRepository {
  if (process.env.POLYVISE_REPOSITORY === "firestore" || process.env.FIRESTORE_PROJECT_ID) {
    return new FirestoreDebateRepository();
  }

  if (process.env.DATABASE_URL) {
    return new PostgresDebateRepository();
  }

  return new MemoryDebateRepository();
}

export function createDefaultFeedbackRepository(): FeedbackRepository {
  if (process.env.POLYVISE_REPOSITORY === "firestore" || process.env.FIRESTORE_PROJECT_ID) {
    return new FirestoreFeedbackRepository();
  }

  if (process.env.DATABASE_URL) {
    return new PostgresFeedbackRepository();
  }

  return new MemoryFeedbackRepository();
}

async function getFirestoreAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedFirestoreToken && cachedFirestoreToken.expiresAt > now + 60_000) {
    return cachedFirestoreToken.accessToken;
  }

  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  }

  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: {
        "Metadata-Flavor": "Google"
      }
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error ?? "Unable to fetch Google metadata access token for Firestore.");
  }

  cachedFirestoreToken = {
    accessToken: payload.access_token,
    expiresAt: now + (payload.expires_in ?? 300) * 1000
  };

  return cachedFirestoreToken.accessToken;
}

async function firestoreRequest(
  projectId: string,
  databaseId: string,
  path: string,
  options: RequestInit & { allowNotFound?: boolean }
): Promise<Record<string, unknown> | null> {
  const token = await getFirestoreAccessToken();
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    }
  );

  if (options.allowNotFound && response.status === 404) {
    return null;
  }

  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Firestore request failed with ${response.status}.`);
  }

  return payload as Record<string, unknown>;
}

function parseFirestoreDebate(document: unknown): DebateRecord | null {
  const fields = (document as { fields?: { recordJson?: { stringValue?: string } } })?.fields;
  const recordJson = fields?.recordJson?.stringValue;

  if (!recordJson) {
    return null;
  }

  return JSON.parse(recordJson) as DebateRecord;
}

function parseFirestoreFeedback(document: unknown): UserFeedback | null {
  const fields = (document as {
    fields?: {
      app?: { stringValue?: string };
      message?: { stringValue?: string };
      debateId?: { stringValue?: string };
      pagePath?: { stringValue?: string };
      userAgent?: { stringValue?: string };
      metadataJson?: { stringValue?: string };
      createdAt?: { timestampValue?: string };
    };
    name?: string;
  })?.fields;

  const app = fields?.app?.stringValue;
  const message = fields?.message?.stringValue;
  const createdAt = fields?.createdAt?.timestampValue;
  if (!app || !message || !createdAt) {
    return null;
  }

  const id = ((document as { name?: string }).name ?? "").split("/").pop();
  if (!id) {
    return null;
  }

  return {
    id,
    app,
    message,
    debateId: fields?.debateId?.stringValue || undefined,
    pagePath: fields?.pagePath?.stringValue || undefined,
    userAgent: fields?.userAgent?.stringValue || undefined,
    metadata: parseJsonObject(fields?.metadataJson?.stringValue),
    createdAt
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
