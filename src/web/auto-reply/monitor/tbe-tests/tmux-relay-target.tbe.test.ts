import { describe, expect, it } from "vitest";
import { parseTmuxRelayTargetFromText } from "../tmux-relay-target.js";

describe("tbe regression: tmux relay target parsing", () => {
  it("parses codex relay label", () => {
    const parsed = parseTmuxRelayTargetFromText(
      "[codex on host 'csem-m0027' in 'tmux -S /tmp/openclaw.sock attach -t codex-123']",
    );

    expect(parsed).toEqual({
      host: "csem-m0027",
      socketPath: "/tmp/openclaw.sock",
      sessionName: "codex-123",
    });
  });

  it("parses gpt-style codex relay label used in whatsapp replies", () => {
    const parsed = parseTmuxRelayTargetFromText(
      "[gpt-5.3-codex/high on host 'csem-m0027:/Users/tbe' in 'tmux -S /var/folders/w5/43wjgdxd2pb4px89tyvgcgc40000gq/T/openclaw-tmux-sockets/openclaw.sock attach -t codex-mac-20260227-134646']",
    );

    expect(parsed).toEqual({
      host: "csem-m0027",
      socketPath:
        "/var/folders/w5/43wjgdxd2pb4px89tyvgcgc40000gq/T/openclaw-tmux-sockets/openclaw.sock",
      sessionName: "codex-mac-20260227-134646",
    });
  });

  it("parses gpt-style codex relay label without thinking suffix", () => {
    const parsed = parseTmuxRelayTargetFromText(
      "[gpt-5.3-codex on host 'csem-m0027:/Users/tbe' in 'tmux -S /tmp/openclaw.sock attach -t codex-mac-20260227-134646']",
    );

    expect(parsed).toEqual({
      host: "csem-m0027",
      socketPath: "/tmp/openclaw.sock",
      sessionName: "codex-mac-20260227-134646",
    });
  });

  it("parses other model tokens when label shape is valid", () => {
    const parsed = parseTmuxRelayTargetFromText(
      "[any-model-v1/medium on host 'host-x:/Users/tbe' in 'tmux -S /tmp/openclaw.sock attach -t codex-abc']",
    );

    expect(parsed).toEqual({
      host: "host-x",
      socketPath: "/tmp/openclaw.sock",
      sessionName: "codex-abc",
    });
  });

  it("returns null for unrelated bracketed text", () => {
    const parsed = parseTmuxRelayTargetFromText("[not-a-relay-label]");
    expect(parsed).toBeNull();
  });
});
