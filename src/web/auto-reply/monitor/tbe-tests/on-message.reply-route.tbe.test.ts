import "../../../test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildMentionConfig } from "../../mentions.js";
import { createEchoTracker } from "../echo.js";
import { createWebOnMessageHandler } from "../on-message.js";
import {
  clearWebReplyRouteIndexForTests,
  rememberWebReplyRouteForOutboundMessages,
} from "../reply-route-index.js";

const { execFileMock, processMessageMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  processMessageMock: vi.fn(async () => true),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../process-message.js", () => ({
  processMessage: processMessageMock,
}));

type ReplyLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeReplyLogger(): ReplyLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

describe("tbe regression: on-message reply-route tmux relay", () => {
  let tempDir: string;
  let storePath: string;
  let replyRoutePath: string;
  let previousReplyRoutePath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tbe-on-message-"));
    storePath = path.join(tempDir, "sessions.json");
    replyRoutePath = path.join(tempDir, "whatsapp-reply-route-index.json");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "sid-main", updatedAt: Date.now() - 1 },
      }),
      "utf8",
    );

    previousReplyRoutePath = process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH;
    process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH = replyRoutePath;

    clearWebReplyRouteIndexForTests();
    processMessageMock.mockClear();
    execFileMock.mockClear();
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        // oxlint-disable-next-line typescript/no-explicit-any
        options: any,
        // oxlint-disable-next-line typescript/no-explicit-any
        callback?: any,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        cb?.(new Error("can't find session: codex-mac-20260227-134646"), "", "can't find session");
        return {} as unknown as ReturnType<typeof execFileMock>;
      },
    );
  });

  afterEach(async () => {
    clearWebReplyRouteIndexForTests();
    if (previousReplyRoutePath === undefined) {
      delete process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH;
    } else {
      process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH = previousReplyRoutePath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    "[gpt-5.3-codex/high on host 'csem-m0027:/Users/tbe' in 'tmux -S /var/folders/w5/43wjgdxd2pb4px89tyvgcgc40000gq/T/openclaw-tmux-sockets/openclaw.sock attach -t codex-mac-20260227-134646']",
    "[gpt-5.3-codex on host 'csem-m0027:/Users/tbe' in 'tmux -S /var/folders/w5/43wjgdxd2pb4px89tyvgcgc40000gq/T/openclaw-tmux-sockets/openclaw.sock attach -t codex-mac-20260227-134646']",
  ])("keeps tmux reply-route when reply body has a valid relay label", async (replyToBody) => {
    const codexTmuxSessionKey = "agent:main:tmux:codex-mac-20260227-134646";
    const chatId = "393351698625@s.whatsapp.net";
    const replyMessageId = "3EB01BB6773C05A3F09E1F";

    rememberWebReplyRouteForOutboundMessages({
      accountId: "default",
      chatId,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: codexTmuxSessionKey,
        mainSessionKey: "agent:main:main",
      },
      messageIds: [replyMessageId],
    });

    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const replyLogger = makeReplyLogger();
    const backgroundTasks = new Set<Promise<unknown>>();
    const handler = createWebOnMessageHandler({
      cfg,
      verbose: false,
      connectionId: "test-conn",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 5,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: createEchoTracker({ maxItems: 10 }),
      backgroundTasks,
      replyResolver: vi.fn().mockResolvedValue(undefined),
      replyLogger: replyLogger as unknown as Parameters<
        typeof createWebOnMessageHandler
      >[0]["replyLogger"],
      baseMentionConfig: buildMentionConfig(cfg),
      account: {},
    });

    await handler({
      id: "msg-inbound-1",
      from: "+393351698625",
      conversationId: "+393351698625",
      chatType: "direct",
      chatId,
      to: "+41767016473",
      accountId: "default",
      timestamp: Date.now(),
      body: "test me",
      replyToId: replyMessageId,
      replyToBody,
      sendComposing: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      sendMedia: vi.fn().mockResolvedValue(undefined),
    });

    const lastProcessCall = processMessageMock.mock.calls.at(-1)?.[0];
    expect(lastProcessCall).toBeDefined();
    expect(lastProcessCall.route.sessionKey).toBe(codexTmuxSessionKey);
    expect(lastProcessCall.tmuxRelayTarget).toMatchObject({
      host: "csem-m0027",
      sessionName: "codex-mac-20260227-134646",
    });
    expect(replyLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "web reply-route miss; using default route",
    );
  });
});
