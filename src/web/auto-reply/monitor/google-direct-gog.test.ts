import { describe, expect, it } from "vitest";
import type { loadConfig } from "../../../config/config.js";
import { runGoogleDirectIntent } from "./google-direct-gog.js";

function makeCfg(): ReturnType<typeof loadConfig> {
  return {
    skills: {
      entries: {
        gog: {
          env: {
            GOG_KEYRING_PASSWORD: "pw-from-config",
          },
        },
      },
    },
  } as ReturnType<typeof loadConfig>;
}

describe("runGoogleDirectIntent", () => {
  it("reads tasks for tomorrow and excludes completed tasks", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runGog = async ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env });
      if (args[0] === "tasks" && args[1] === "lists") {
        return JSON.stringify([{ id: "list-1", title: "Tasks" }]);
      }
      return JSON.stringify([
        { id: "t1", title: "Do slides", status: "needsAction", due: "2026-02-26T10:00:00.000Z" },
        { id: "t2", title: "Done item", status: "completed" },
      ]);
    };

    const result = await runGoogleDirectIntent({
      cfg: makeCfg(),
      now: new Date("2026-02-25T12:00:00.000Z"),
      intent: {
        kind: "tasks_read",
        originalText: "what tasks tomorrow",
        day: "tomorrow",
      },
      runGog,
    });

    expect(result.text).toContain("Tasks:");
    expect(result.text).toContain("Do slides");
    expect(result.text).not.toContain("Done item");
    expect(calls[0]?.args).toEqual([
      "tasks",
      "lists",
      "list",
      "--account",
      "tommaso.bendinelli@gmail.com",
      "--json",
      "--no-input",
    ]);
    expect(calls[1]?.args).toContain("--due-min");
    expect(calls[1]?.args).toContain("--due-max");
    expect(calls[1]?.env.GOG_KEYRING_PASSWORD).toBe("pw-from-config");
  });

  it("reads calendar events for today", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runGog = async ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env });
      return JSON.stringify([
        {
          id: "e1",
          summary: "Doctor",
          start: { dateTime: "2026-02-25T09:00:00.000Z" },
          end: { dateTime: "2026-02-25T10:00:00.000Z" },
        },
      ]);
    };

    const result = await runGoogleDirectIntent({
      cfg: makeCfg(),
      now: new Date("2026-02-25T12:00:00.000Z"),
      intent: {
        kind: "calendar_read",
        originalText: "calendar today",
        day: "today",
      },
      runGog,
    });

    expect(result.text).toContain("Calendar events:");
    expect(result.text).toContain("Doctor");
    expect(calls[0]?.args).toEqual([
      "calendar",
      "events",
      "primary",
      "--account",
      "tommaso.bendinelli@gmail.com",
      "--json",
      "--no-input",
      "--max",
      "30",
      "--today",
    ]);
  });

  it("creates task with due date for tomorrow", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runGog = async ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env });
      if (args[0] === "tasks" && args[1] === "lists") {
        return JSON.stringify([{ id: "list-2", title: "Default" }]);
      }
      return JSON.stringify({ id: "new-task", title: "Buy milk" });
    };

    const result = await runGoogleDirectIntent({
      cfg: makeCfg(),
      now: new Date("2026-02-25T12:00:00.000Z"),
      intent: {
        kind: "tasks_write",
        originalText: "add task buy milk tomorrow",
        day: "tomorrow",
        title: "Buy milk",
      },
      runGog,
    });

    expect(result.text).toBe("Task created: Buy milk");
    const dueFlagIndex = calls[1]?.args.indexOf("--due") ?? -1;
    expect(dueFlagIndex).toBeGreaterThan(-1);
    const dueValue = calls[1]?.args[dueFlagIndex + 1];
    expect(dueValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("creates calendar event with explicit time", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runGog = async ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env });
      return JSON.stringify({ id: "new-event", summary: "Dentist" });
    };

    const result = await runGoogleDirectIntent({
      cfg: makeCfg(),
      now: new Date("2026-02-25T12:00:00.000Z"),
      intent: {
        kind: "calendar_write",
        originalText: "add event dentist tomorrow at 11:30",
        day: "tomorrow",
        title: "Dentist",
        hour: 11,
        minute: 30,
      },
      runGog,
      env: { GOG_ACCOUNT: "custom@example.com" },
    });

    expect(result.text).toBe("Calendar event created: Dentist");
    expect(calls[0]?.args[0]).toBe("calendar");
    expect(calls[0]?.args).toContain("--account");
    expect(calls[0]?.args).toContain("custom@example.com");
    const fromIndex = calls[0]?.args.indexOf("--from") ?? -1;
    const toIndex = calls[0]?.args.indexOf("--to") ?? -1;
    expect(fromIndex).toBeGreaterThan(-1);
    expect(toIndex).toBeGreaterThan(-1);
    const fromIso = calls[0]?.args[fromIndex + 1];
    const toIso = calls[0]?.args[toIndex + 1];
    expect(typeof fromIso).toBe("string");
    expect(typeof toIso).toBe("string");
    const fromMillis = Date.parse(fromIso ?? "");
    const toMillis = Date.parse(toIso ?? "");
    expect(Number.isFinite(fromMillis)).toBe(true);
    expect(Number.isFinite(toMillis)).toBe(true);
    expect(toMillis - fromMillis).toBe(60 * 60 * 1000);
  });
});
