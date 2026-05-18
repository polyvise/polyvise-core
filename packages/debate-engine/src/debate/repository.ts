import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { debateRecords } from "../db/schema";
import type { DebateRecord } from "./types";

export interface DebateRepository {
  save(debate: DebateRecord): Promise<void>;
  get(id: string): Promise<DebateRecord | null>;
  list(): Promise<DebateRecord[]>;
}

type MemoryRepositoryState = {
  debates: Map<string, DebateRecord>;
};

const globalForRepository = globalThis as typeof globalThis & {
  __polyviseDebateRepository?: MemoryRepositoryState;
};

export class MemoryDebateRepository implements DebateRepository {
  private readonly state: MemoryRepositoryState;

  constructor(
    state =
      globalForRepository.__polyviseDebateRepository ??
      (globalForRepository.__polyviseDebateRepository = {
        debates: new Map()
      })
  ) {
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

export function createDefaultDebateRepository(): DebateRepository {
  if (process.env.POLYVISE_REPOSITORY === "firestore" || process.env.FIRESTORE_PROJECT_ID) {
    return new FirestoreDebateRepository();
  }

  if (process.env.DATABASE_URL) {
    return new PostgresDebateRepository();
  }

  return new MemoryDebateRepository();
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

function parseFirestoreDebate(document: unknown): DebateRecord | null {
  const fields = (document as { fields?: { recordJson?: { stringValue?: string } } })?.fields;
  const recordJson = fields?.recordJson?.stringValue;

  if (!recordJson) {
    return null;
  }

  return JSON.parse(recordJson) as DebateRecord;
}
