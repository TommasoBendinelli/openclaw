import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sessionDir: string | undefined;
let sessionStorePath: string;
let backgroundTasks: Set<Promise<unknown>>;
let previousSocketDir: string | undefined;
let previousTmpDir: string | undefined;

const { execFileMock, dispatchMock, deliverWebReplyMock, sleepMock, callGatewayMock } = vi.hoisted(
  () => ({
    execFileMock: vi.fn(),
    dispatchMock: vi.fn(async () => ({ queuedFinal: false })),
    deliverWebReplyMock: vi.fn(async () => ["outbound-1"]),
    sleepMock: vi.fn(async () => {}),
    callGatewayMock: vi.fn(),
  }),
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: dispatchMock,
}));

vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: deliverWebReplyMock,
}));

vi.mock("../../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../../utils.js")>("../../../utils.js");
  return {
    ...actual,
    sleep: sleepMock,
  };
});

vi.mock("../../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn(),
}));

import { processMessage } from "./process-message.js";

function makeArgs() {
  return {
    cfg: { messages: {}, session: { store: sessionStorePath } },
    msg: {
      id: "msg-1",
      from: "+15550001111",
      to: "+15550002222",
      accountId: "default",
      body: "ciao codex",
      chatType: "direct",
      chatId: "393351698625@s.whatsapp.net",
      sendComposing: async () => {},
      reply: async () => ({ messageId: "reply-id-1" }),
      sendMedia: async () => ({ messageId: "reply-id-2" }),
    },
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:tmux:codex_openclaw_mac",
      mainSessionKey: "agent:main:main",
    },
    groupHistoryKey: "+15550001111",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1,
    replyResolver: async () => undefined,
    replyLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    backgroundTasks,
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    tmuxRelayTarget: undefined,
  };
}

describe("web processMessage deterministic tmux relay", () => {
  beforeEach(async () => {
    dispatchMock.mockClear();
    deliverWebReplyMock.mockClear();
    sleepMock.mockClear();
    callGatewayMock.mockClear();
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "node-mac",
              displayName: "csem-m0027",
              connected: true,
              commands: ["system.run"],
            },
          ],
        };
      }
      if (opts.method === "node.invoke") {
        return { payload: { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" } };
      }
      return {};
    });
    vi.mocked(execFile).mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        // oxlint-disable-next-line typescript/no-explicit-any
        options: any,
        // oxlint-disable-next-line typescript/no-explicit-any
        callback?: any,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        cb?.(null, "", "");
        return {} as unknown as ReturnType<typeof execFile>;
      },
    );
    backgroundTasks = new Set();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-process-message-tmux-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
    previousSocketDir = process.env.OPENCLAW_TMUX_SOCKET_DIR;
    previousTmpDir = process.env.TMPDIR;
    process.env.OPENCLAW_TMUX_SOCKET_DIR = "/tmp/tmux-test-sockets";
  });

  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    vi.mocked(execFile).mockReset();
    if (previousSocketDir === undefined) {
      delete process.env.OPENCLAW_TMUX_SOCKET_DIR;
    } else {
      process.env.OPENCLAW_TMUX_SOCKET_DIR = previousSocketDir;
    }
    if (previousTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpDir;
    }
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  it("forwards to tmux and waits 500ms before Enter without invoking dispatcher", async () => {
    const didSend = await processMessage(makeArgs());
    expect(didSend).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
      "-S",
      "/tmp/tmux-test-sockets/openclaw.sock",
      "send-keys",
      "-t",
      "codex_openclaw_mac:0.0",
      "-l",
      "--",
      "ciao codex",
    ]);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(500);
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual([
      "-S",
      "/tmp/tmux-test-sockets/openclaw.sock",
      "send-keys",
      "-t",
      "codex_openclaw_mac:0.0",
      "Enter",
    ]);
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverWebReplyMock.mock.calls[0]?.[0]?.replyResult?.text).toContain(
      "[codex in 'tmux -S /tmp/tmux-test-sockets/openclaw.sock attach -t codex_openclaw_mac'] Prompt: ciao codex",
    );
  });

  it("forwards audio marker replies to tmux without invoking dispatcher", async () => {
    const args = makeArgs();
    args.msg.body = "<media:audio>";
    args.msg.mediaType = "audio/ogg; codecs=opus";
    args.msg.mediaPath = "/tmp/inbound-audio.ogg";

    const didSend = await processMessage(args);
    const expectedAudioPrompt =
      '<media:audio> [media_path="/tmp/inbound-audio.ogg"] [media_type="audio/ogg; codecs=opus"]';

    expect(didSend).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
      "-S",
      "/tmp/tmux-test-sockets/openclaw.sock",
      "send-keys",
      "-t",
      "codex_openclaw_mac:0.0",
      "-l",
      "--",
      expectedAudioPrompt,
    ]);
    expect(sleepMock).toHaveBeenCalledWith(500);
    expect(deliverWebReplyMock.mock.calls[0]?.[0]?.replyResult?.text).toContain(
      `Prompt: ${expectedAudioPrompt}`,
    );
  });

  it("forwards to remote tmux via node.invoke when relay target host is remote", async () => {
    const args = makeArgs();
    args.tmuxRelayTarget = {
      host: "csem-m0027",
      socketPath: "/var/folders/xx/T/openclaw-tmux-sockets/openclaw.sock",
      sessionName: "codex_openclaw_mac",
    };

    const didSend = await processMessage(args);

    expect(didSend).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(3);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "node.list" });
    expect(callGatewayMock.mock.calls[1]?.[0]).toMatchObject({
      method: "node.invoke",
      params: {
        nodeId: "node-mac",
        command: "system.run",
        params: {
          command: [
            "tmux",
            "-S",
            "/var/folders/xx/T/openclaw-tmux-sockets/openclaw.sock",
            "send-keys",
            "-t",
            "codex_openclaw_mac:0.0",
            "-l",
            "--",
            "ciao codex",
          ],
        },
      },
    });
    expect(sleepMock).toHaveBeenCalledWith(500);
    expect(callGatewayMock.mock.calls[2]?.[0]).toMatchObject({
      method: "node.invoke",
      params: {
        nodeId: "node-mac",
        command: "system.run",
        params: {
          command: [
            "tmux",
            "-S",
            "/var/folders/xx/T/openclaw-tmux-sockets/openclaw.sock",
            "send-keys",
            "-t",
            "codex_openclaw_mac:0.0",
            "Enter",
          ],
        },
      },
    });
    expect(deliverWebReplyMock.mock.calls[0]?.[0]?.replyResult?.text).toContain(
      "[codex on host 'csem-m0027' in 'tmux -S /var/folders/xx/T/openclaw-tmux-sockets/openclaw.sock attach -t codex_openclaw_mac'] Prompt: ciao codex",
    );
  });
});
