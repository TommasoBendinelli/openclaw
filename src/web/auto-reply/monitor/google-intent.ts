export type GoogleIntentKind = "tasks_read" | "calendar_read" | "tasks_write" | "calendar_write";

export type GoogleIntentDay = "today" | "tomorrow" | null;

export type GoogleDirectIntent = {
  kind: GoogleIntentKind;
  originalText: string;
  day: GoogleIntentDay;
  title?: string;
  hour?: number;
  minute?: number;
};

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function detectDay(text: string): GoogleIntentDay {
  if (/\b(tomorrow|domani)\b/i.test(text)) {
    return "tomorrow";
  }
  if (/\b(today|oggi|stasera|tonight)\b/i.test(text)) {
    return "today";
  }
  return null;
}

function detectTime(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(/\b(?:at|alle?)\s*(\d{1,2})(?::(\d{2}))?\b/i);
  if (!match) {
    return undefined;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    return undefined;
  }
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

function cleanupTitle(raw: string): string {
  return raw
    .replace(/\b(today|tomorrow|oggi|domani|stasera|tonight)\b/gi, " ")
    .replace(/\b(?:at|alle?)\s*\d{1,2}(?::\d{2})?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function extractWriteTitle(text: string, type: "task" | "event"): string | undefined {
  const taskPattern = /\b(?:add|create|aggiungi|crea)\s+(?:a\s+)?task\b[:\s-]*(.+)$/i;
  const eventPattern =
    /\b(?:add|create|schedule|aggiungi|crea|metti(?:\s+in\s+calendario)?)\s+(?:an?\s+)?(?:event|evento|calendar event)\b[:\s-]*(.+)$/i;
  const match = (type === "task" ? taskPattern : eventPattern).exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  const cleaned = cleanupTitle(match[1]);
  return cleaned || undefined;
}

export function detectGoogleDirectIntent(text: string | undefined): GoogleDirectIntent | null {
  const originalText = (text ?? "").trim();
  if (!originalText) {
    return null;
  }
  const normalized = normalizeToken(originalText);
  const day = detectDay(normalized);
  const parsedTime = detectTime(normalized);

  const taskWriteTitle = extractWriteTitle(originalText, "task");
  if (taskWriteTitle) {
    return {
      kind: "tasks_write",
      originalText,
      day,
      title: taskWriteTitle,
      ...parsedTime,
    };
  }

  const eventWriteTitle = extractWriteTitle(originalText, "event");
  if (eventWriteTitle) {
    return {
      kind: "calendar_write",
      originalText,
      day,
      title: eventWriteTitle,
      ...parsedTime,
    };
  }

  const tasksRead =
    /\b(tasks?|todo|to do)\b/i.test(normalized) ||
    /\b(cosa devo fare|che task devo fare|what do i have to do)\b/i.test(normalized);
  if (tasksRead) {
    return {
      kind: "tasks_read",
      originalText,
      day,
    };
  }

  const calendarRead =
    /\b(calendar|calendario|eventi|impegni|appuntamenti)\b/i.test(normalized) ||
    /\b(what do i have|cosa ho)\b/i.test(normalized);
  if (calendarRead) {
    return {
      kind: "calendar_read",
      originalText,
      day,
    };
  }

  return null;
}
