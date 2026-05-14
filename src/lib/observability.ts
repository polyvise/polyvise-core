type LogLevel = "info" | "warn" | "error";

export interface PolyviseLogEvent {
  level: LogLevel;
  event: string;
  debateId?: string;
  runId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export function logEvent(event: PolyviseLogEvent): void {
  const payload = {
    at: new Date().toISOString(),
    service: "polyvise-web",
    ...event
  };

  if (event.level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (event.level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.info(JSON.stringify(payload));
}
