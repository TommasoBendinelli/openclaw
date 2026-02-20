import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWebReplyRouteIndexForTests,
  flushWebReplyRouteIndexForTests,
  rememberWebReplyRouteForOutboundMessages,
  resetWebReplyRouteIndexLoadStateForTests,
  resolveWebReplyRouteByMessageId,
} from "./reply-route-index.js";

describe("web reply-route index persistence", () => {
  let tempDir: string;
  let indexPath: string;
  let previousIndexPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reply-route-index-"));
    indexPath = path.join(tempDir, "whatsapp-reply-route-index.json");
    previousIndexPath = process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH;
    process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH = indexPath;
    clearWebReplyRouteIndexForTests();
    resetWebReplyRouteIndexLoadStateForTests();
  });

  afterEach(async () => {
    clearWebReplyRouteIndexForTests();
    if (previousIndexPath === undefined) {
      delete process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH;
    } else {
      process.env.OPENCLAW_REPLY_ROUTE_INDEX_PATH = previousIndexPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists and reloads exact reply route entries across resets", async () => {
    rememberWebReplyRouteForOutboundMessages({
      accountId: "default",
      chatId: "393351698625@s.whatsapp.net",
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:tmux:codex_mac_how_is_doing",
        mainSessionKey: "agent:main:main",
      },
      messageIds: ["msg-1"],
    });
    await flushWebReplyRouteIndexForTests();

    clearWebReplyRouteIndexForTests();
    resetWebReplyRouteIndexLoadStateForTests();

    const resolved = resolveWebReplyRouteByMessageId({
      accountId: "default",
      chatId: "393351698625@s.whatsapp.net",
      replyToId: "msg-1",
    });

    expect(resolved).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:tmux:codex_mac_how_is_doing",
      matchType: "exact",
    });
  });

  it("reloads and resolves account-message fallback when chatId format changes", async () => {
    rememberWebReplyRouteForOutboundMessages({
      accountId: "default",
      chatId: "15551234567@s.whatsapp.net",
      route: {
        agentId: "work",
        accountId: "default",
        sessionKey: "agent:work:tmux:codex_openclaw_mac",
        mainSessionKey: "agent:work:main",
      },
      messageIds: ["msg-lid-1"],
    });
    await flushWebReplyRouteIndexForTests();

    clearWebReplyRouteIndexForTests();
    resetWebReplyRouteIndexLoadStateForTests();

    const resolved = resolveWebReplyRouteByMessageId({
      accountId: "default",
      chatId: "15551234567@lid",
      replyToId: "msg-lid-1",
    });

    expect(resolved).toMatchObject({
      agentId: "work",
      sessionKey: "agent:work:tmux:codex_openclaw_mac",
      matchType: "account-message-fallback",
    });
  });

  it("ignores expired persisted entries", async () => {
    const nowMs = Date.now();
    const oldMs = nowMs - 22 * 24 * 60 * 60 * 1000;
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        savedAtMs: nowMs,
        entries: [
          {
            accountId: "default",
            chatId: "393351698625@s.whatsapp.net",
            messageId: "expired-msg",
            agentId: "main",
            sessionKey: "agent:main:tmux:codex_mac_how_is_doing",
            mainSessionKey: "agent:main:main",
            createdAtMs: oldMs,
          },
        ],
      }),
      "utf8",
    );

    clearWebReplyRouteIndexForTests();
    resetWebReplyRouteIndexLoadStateForTests();

    const resolved = resolveWebReplyRouteByMessageId({
      accountId: "default",
      chatId: "393351698625@s.whatsapp.net",
      replyToId: "expired-msg",
      nowMs,
    });

    expect(resolved).toBeNull();
  });
});
