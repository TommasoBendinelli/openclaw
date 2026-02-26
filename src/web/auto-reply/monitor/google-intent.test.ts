import { describe, expect, it } from "vitest";
import { detectGoogleDirectIntent } from "./google-intent.js";

describe("detectGoogleDirectIntent", () => {
  it("detects tasks read from natural language", () => {
    const intent = detectGoogleDirectIntent("can you tell me which tasks I need to do tomorrow?");
    expect(intent?.kind).toBe("tasks_read");
    expect(intent?.day).toBe("tomorrow");
  });

  it("detects calendar read from italian natural language", () => {
    const intent = detectGoogleDirectIntent("che impegni ho oggi in calendario?");
    expect(intent?.kind).toBe("calendar_read");
    expect(intent?.day).toBe("today");
  });

  it("detects task write with title/date/time", () => {
    const intent = detectGoogleDirectIntent("aggiungi task fare slides per iason domani alle 16");
    expect(intent?.kind).toBe("tasks_write");
    expect(intent?.title).toBe("fare slides per iason");
    expect(intent?.day).toBe("tomorrow");
    expect(intent?.hour).toBe(16);
    expect(intent?.minute).toBe(0);
  });

  it("detects calendar write", () => {
    const intent = detectGoogleDirectIntent("add event dentist appointment tomorrow at 11:30");
    expect(intent?.kind).toBe("calendar_write");
    expect(intent?.title).toBe("dentist appointment");
    expect(intent?.day).toBe("tomorrow");
    expect(intent?.hour).toBe(11);
    expect(intent?.minute).toBe(30);
  });

  it("returns null for non-google requests", () => {
    const intent = detectGoogleDirectIntent("how are you doing?");
    expect(intent).toBeNull();
  });
});
