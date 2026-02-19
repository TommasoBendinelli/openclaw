import "./test-helpers.js";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { awaitBackgroundTasks } from "./auto-reply/monitor/last-route.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
import {
  clearWebReplyRouteIndexForTests,
  rememberWebReplyRouteForOutboundMessages,
} from "./auto-reply/monitor/reply-route-index.js";

function makeCfg(storePath: string): OpenClawConfig {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function makeReplyLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"];
}

function createHandlerForTest(opts: { cfg: OpenClawConfig; replyResolver: unknown }) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const handler = createWebOnMessageHandler({
    cfg: opts.cfg,
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks,
    replyResolver: opts.replyResolver as Parameters<
      typeof createWebOnMessageHandler
    >[0]["replyResolver"],
    replyLogger: makeReplyLogger(),
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {},
  });

  return { handler, backgroundTasks };
}

function createLastRouteHarness(storePath: string) {
  const replyResolver = vi.fn().mockResolvedValue(undefined);
  const cfg = makeCfg(storePath);
  return createHandlerForTest({ cfg, replyResolver });
}

function buildInboundMessage(params: {
  id: string;
  from: string;
  conversationId: string;
  chatType: "direct" | "group";
  chatId: string;
  timestamp: number;
  body?: string;
  to?: string;
  accountId?: string;
  senderE164?: string;
  senderName?: string;
  selfE164?: string;
  replyToId?: string;
}) {
  return {
    id: params.id,
    from: params.from,
    conversationId: params.conversationId,
    to: params.to ?? "+2000",
    body: params.body ?? "hello",
    timestamp: params.timestamp,
    chatType: params.chatType,
    chatId: params.chatId,
    accountId: params.accountId ?? "default",
    senderE164: params.senderE164,
    senderName: params.senderName,
    selfE164: params.selfE164,
    replyToId: params.replyToId,
    sendComposing: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
  };
}

async function readStoredRoutes(storePath: string) {
  return JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
    string,
    { lastChannel?: string; lastTo?: string; lastAccountId?: string }
  >;
}

describe("web auto-reply last-route", () => {
  installWebAutoReplyUnitTestHooks();

  it("routes direct replies by outbound message id before normal routing", async () => {
    clearWebReplyRouteIndexForTests();
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const workSessionKey = "agent:work:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid-main", updatedAt: now - 2 },
      [workSessionKey]: { sessionId: "sid-work", updatedAt: now - 1 },
    });

    rememberWebReplyRouteForOutboundMessages({
      accountId: "default",
      chatId: "chat:+1000",
      route: {
        agentId: "work",
        accountId: "default",
        sessionKey: workSessionKey,
        mainSessionKey: workSessionKey,
      },
      messageIds: ["bot-msg-1"],
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

    await handler(
      buildInboundMessage({
        id: "m-reply-1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "chat:+1000",
        timestamp: now,
        replyToId: "bot-msg-1",
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);
    const stored = await readStoredRoutes(store.storePath);
    expect(stored[workSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[workSessionKey]?.lastTo).toBe("+1000");

    clearWebReplyRouteIndexForTests();
    await store.cleanup();
  });

  it("routes direct replies when chatId format differs but message id matches", async () => {
    clearWebReplyRouteIndexForTests();
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const workSessionKey = "agent:work:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid-main", updatedAt: now - 2 },
      [workSessionKey]: { sessionId: "sid-work", updatedAt: now - 1 },
    });

    rememberWebReplyRouteForOutboundMessages({
      accountId: "default",
      chatId: "15551234567@s.whatsapp.net",
      route: {
        agentId: "work",
        accountId: "default",
        sessionKey: workSessionKey,
        mainSessionKey: workSessionKey,
      },
      messageIds: ["bot-msg-lid-1"],
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

    await handler(
      buildInboundMessage({
        id: "m-reply-lid-1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "15551234567@lid",
        timestamp: now,
        replyToId: "bot-msg-lid-1",
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);
    const stored = await readStoredRoutes(store.storePath);
    expect(stored[workSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[workSessionKey]?.lastTo).toBe("+1000");

    clearWebReplyRouteIndexForTests();
    await store.cleanup();
  });

  it("updates last-route for direct chats without senderE164", async () => {
    clearWebReplyRouteIndexForTests();
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

    await handler(
      buildInboundMessage({
        id: "m1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "direct:+1000",
        timestamp: now,
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);

    const stored = await readStoredRoutes(store.storePath);
    expect(stored[mainSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[mainSessionKey]?.lastTo).toBe("+1000");

    clearWebReplyRouteIndexForTests();
    await store.cleanup();
  });

  it("updates last-route for group chats with account id", async () => {
    clearWebReplyRouteIndexForTests();
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

    await handler(
      buildInboundMessage({
        id: "g1",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatType: "group",
        chatId: "123@g.us",
        timestamp: now,
        accountId: "work",
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000",
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);

    const stored = await readStoredRoutes(store.storePath);
    expect(stored[groupSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[groupSessionKey]?.lastTo).toBe("123@g.us");
    expect(stored[groupSessionKey]?.lastAccountId).toBe("work");

    clearWebReplyRouteIndexForTests();
    await store.cleanup();
  });
});
