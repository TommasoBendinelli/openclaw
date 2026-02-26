import { execFile } from "node:child_process";
import type { loadConfig } from "../../../config/config.js";
import { formatError } from "../../session.js";
import type { GoogleDirectIntent } from "./google-intent.js";

type GogRunner = (params: { args: string[]; env: NodeJS.ProcessEnv }) => Promise<string>;

type GogTaskList = {
  id?: string;
  title?: string;
};

type GogTask = {
  id?: string;
  title?: string;
  due?: string;
  status?: string;
};

type GogCalendarEvent = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

const DEFAULT_GOG_ACCOUNT = "tommaso.bendinelli@gmail.com";
const DEFAULT_GOG_BIN = "gog";

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function unwrapResults(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.results)) {
    return obj.results;
  }
  if (Array.isArray(obj.items)) {
    return obj.items;
  }
  if (obj.result !== undefined) {
    return obj.result;
  }
  return value;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function dayWindow(day: "today" | "tomorrow" | null, now: Date): { from: Date; to: Date } | null {
  if (!day) {
    return null;
  }
  const base = startOfDay(now);
  if (day === "tomorrow") {
    base.setDate(base.getDate() + 1);
  }
  return { from: base, to: endOfDay(base) };
}

async function runExecFile(params: { args: string[]; env: NodeJS.ProcessEnv }): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      DEFAULT_GOG_BIN,
      params.args,
      { encoding: "utf8", env: params.env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout ?? ""));
          return;
        }
        const reason = String(stderr ?? "").trim() || formatError(error);
        reject(new Error(reason));
      },
    );
  });
}

function formatTaskLine(task: GogTask): string {
  const title = task.title?.trim() || "(untitled)";
  const due = task.due?.trim();
  return due ? `- ${title} (due ${due})` : `- ${title}`;
}

function formatEventLine(event: GogCalendarEvent): string {
  const summary = event.summary?.trim() || "(untitled)";
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  const range = start || end ? `${start ?? "?"} -> ${end ?? "?"}` : "time unavailable";
  return `- ${summary} (${range})`;
}

function resolveGogEnv(
  cfg: ReturnType<typeof loadConfig>,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  const pw = cfg.skills?.entries?.gog?.env?.GOG_KEYRING_PASSWORD;
  if (typeof pw === "string" && pw.trim()) {
    env.GOG_KEYRING_PASSWORD = pw.trim();
  }
  return env;
}

function resolveAccount(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.GOG_ACCOUNT?.trim();
  return fromEnv || DEFAULT_GOG_ACCOUNT;
}

async function resolveDefaultTaskListId(params: {
  runGog: GogRunner;
  env: NodeJS.ProcessEnv;
  account: string;
}): Promise<string> {
  const out = await params.runGog({
    args: ["tasks", "lists", "list", "--account", params.account, "--json", "--no-input"],
    env: params.env,
  });
  const lists = toArray<GogTaskList>(unwrapResults(parseJson<unknown>(out)));
  const first = lists.find((entry) => typeof entry.id === "string" && entry.id.trim());
  if (!first?.id) {
    throw new Error("No Google Task list found");
  }
  return first.id;
}

function buildDateFromIntent(params: {
  day: "today" | "tomorrow" | null;
  hour: number | undefined;
  minute: number | undefined;
  now: Date;
}): Date {
  const base = startOfDay(params.now);
  if (params.day === "tomorrow") {
    base.setDate(base.getDate() + 1);
  }
  const hour = params.hour ?? 9;
  const minute = params.minute ?? 0;
  base.setHours(hour, minute, 0, 0);
  return base;
}

export async function runGoogleDirectIntent(params: {
  cfg: ReturnType<typeof loadConfig>;
  intent: GoogleDirectIntent;
  now?: Date;
  runGog?: GogRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<{ text: string }> {
  const now = params.now ?? new Date();
  const env = resolveGogEnv(params.cfg, params.env);
  const runGog = params.runGog ?? runExecFile;
  const account = resolveAccount(env);
  const window = dayWindow(params.intent.day, now);

  if (params.intent.kind === "tasks_read") {
    const taskListId = await resolveDefaultTaskListId({ runGog, env, account });
    const args = [
      "tasks",
      "list",
      taskListId,
      "--account",
      account,
      "--json",
      "--no-input",
      "--max",
      "100",
    ];
    if (window) {
      args.push("--due-min", window.from.toISOString(), "--due-max", window.to.toISOString());
    }
    const out = await runGog({ args, env });
    const tasks = toArray<GogTask>(unwrapResults(parseJson<unknown>(out))).filter(
      (task) => (task.status ?? "").toLowerCase() !== "completed",
    );
    if (tasks.length === 0) {
      return { text: "No tasks found for that period." };
    }
    return { text: ["Tasks:", ...tasks.map(formatTaskLine)].join("\n") };
  }

  if (params.intent.kind === "calendar_read") {
    const args = [
      "calendar",
      "events",
      "primary",
      "--account",
      account,
      "--json",
      "--no-input",
      "--max",
      "30",
    ];
    if (params.intent.day === "today") {
      args.push("--today");
    } else if (params.intent.day === "tomorrow") {
      args.push("--tomorrow");
    } else {
      args.push("--days", "7");
    }
    const out = await runGog({ args, env });
    const events = toArray<GogCalendarEvent>(unwrapResults(parseJson<unknown>(out)));
    if (events.length === 0) {
      return { text: "No calendar events found for that period." };
    }
    return { text: ["Calendar events:", ...events.map(formatEventLine)].join("\n") };
  }

  if (params.intent.kind === "tasks_write") {
    const title = params.intent.title?.trim();
    if (!title) {
      throw new Error("Missing task title");
    }
    const taskListId = await resolveDefaultTaskListId({ runGog, env, account });
    const args = [
      "tasks",
      "add",
      taskListId,
      "--account",
      account,
      "--title",
      title,
      "--json",
      "--no-input",
    ];
    if (window) {
      args.push("--due", window.from.toISOString().slice(0, 10));
    }
    const out = await runGog({ args, env });
    const created = unwrapResults(parseJson<unknown>(out)) as GogTask;
    return { text: `Task created: ${created.title?.trim() || title}` };
  }

  const title = params.intent.title?.trim();
  if (!title) {
    throw new Error("Missing event title");
  }
  const start = buildDateFromIntent({
    day: params.intent.day,
    hour: params.intent.hour,
    minute: params.intent.minute,
    now,
  });
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const out = await runGog({
    args: [
      "calendar",
      "create",
      "primary",
      "--account",
      account,
      "--summary",
      title,
      "--from",
      start.toISOString(),
      "--to",
      end.toISOString(),
      "--json",
      "--no-input",
    ],
    env,
  });
  const created = unwrapResults(parseJson<unknown>(out)) as GogCalendarEvent;
  return { text: `Calendar event created: ${created.summary?.trim() || title}` };
}
