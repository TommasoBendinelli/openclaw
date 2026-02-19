import type { ResolvedAgentRoute } from "../../../routing/resolve-route.js";

type StoredWebReplyRouteTarget = Pick<
  ResolvedAgentRoute,
  "agentId" | "accountId" | "sessionKey" | "mainSessionKey"
> & {
  chatId: string;
};

export type WebReplyRouteTarget = StoredWebReplyRouteTarget & {
  matchType: "exact" | "account-message-fallback";
};

type ReplyRouteEntry = StoredWebReplyRouteTarget & {
  createdAtMs: number;
};

const REPLY_ROUTE_TTL_MS = 21 * 24 * 60 * 60 * 1000;
const REPLY_ROUTE_MAX_ENTRIES = 20_000;
const replyRouteIndex = new Map<string, ReplyRouteEntry>();
const replyRouteByAccountMessage = new Map<string, ReplyRouteEntry>();

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function buildReplyRouteKey(params: {
  accountId: string;
  chatId: string;
  messageId: string;
}): string | null {
  const accountId = normalizeToken(params.accountId);
  const chatId = normalizeToken(params.chatId);
  const messageId = normalizeToken(params.messageId);
  if (!accountId || !chatId || !messageId) {
    return null;
  }
  return `${accountId}\u0001${chatId}\u0001${messageId}`;
}

function buildAccountMessageKey(params: { accountId: string; messageId: string }): string | null {
  const accountId = normalizeToken(params.accountId);
  const messageId = normalizeToken(params.messageId);
  if (!accountId || !messageId) {
    return null;
  }
  return `${accountId}\u0001${messageId}`;
}

function dropSecondaryIndexIfMatches(params: {
  accountMessageKey: string | null;
  entry: ReplyRouteEntry;
}) {
  if (!params.accountMessageKey) {
    return;
  }
  const mapped = replyRouteByAccountMessage.get(params.accountMessageKey);
  if (mapped === params.entry) {
    replyRouteByAccountMessage.delete(params.accountMessageKey);
  }
}

function pruneExpired(nowMs: number) {
  for (const [key, entry] of replyRouteIndex) {
    if (nowMs - entry.createdAtMs <= REPLY_ROUTE_TTL_MS) {
      continue;
    }
    replyRouteIndex.delete(key);
    dropSecondaryIndexIfMatches({
      accountMessageKey: buildAccountMessageKey({
        accountId: entry.accountId,
        messageId: key.split("\u0001")[2] ?? "",
      }),
      entry,
    });
  }
}

function trimOverflow() {
  if (replyRouteIndex.size <= REPLY_ROUTE_MAX_ENTRIES) {
    return;
  }
  const overflow = replyRouteIndex.size - REPLY_ROUTE_MAX_ENTRIES;
  let removed = 0;
  for (const key of replyRouteIndex.keys()) {
    const entry = replyRouteIndex.get(key);
    replyRouteIndex.delete(key);
    if (entry) {
      dropSecondaryIndexIfMatches({
        accountMessageKey: buildAccountMessageKey({
          accountId: entry.accountId,
          messageId: key.split("\u0001")[2] ?? "",
        }),
        entry,
      });
    }
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
}

export function rememberWebReplyRouteForOutboundMessages(params: {
  accountId: string;
  chatId: string;
  route: Pick<ResolvedAgentRoute, "agentId" | "accountId" | "sessionKey" | "mainSessionKey">;
  messageIds: readonly string[];
  nowMs?: number;
}) {
  const nowMs = params.nowMs ?? Date.now();
  pruneExpired(nowMs);
  for (const outboundMessageId of params.messageIds) {
    const key = buildReplyRouteKey({
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: outboundMessageId,
    });
    if (!key) {
      continue;
    }
    const entry: ReplyRouteEntry = {
      agentId: params.route.agentId,
      accountId: params.route.accountId,
      sessionKey: params.route.sessionKey,
      mainSessionKey: params.route.mainSessionKey,
      chatId: params.chatId.trim(),
      createdAtMs: nowMs,
    };
    replyRouteIndex.set(key, entry);
    const accountMessageKey = buildAccountMessageKey({
      accountId: params.accountId,
      messageId: outboundMessageId,
    });
    if (accountMessageKey) {
      replyRouteByAccountMessage.set(accountMessageKey, entry);
    }
  }
  trimOverflow();
}

export function resolveWebReplyRouteByMessageId(params: {
  accountId: string;
  chatId: string;
  replyToId: string | undefined;
  nowMs?: number;
}): WebReplyRouteTarget | null {
  const replyToId = normalizeToken(params.replyToId);
  if (!replyToId) {
    return null;
  }
  const key = buildReplyRouteKey({
    accountId: params.accountId,
    chatId: params.chatId,
    messageId: replyToId,
  });
  if (!key) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpired(nowMs);
  let entry = replyRouteIndex.get(key);
  let matchType: WebReplyRouteTarget["matchType"] = "exact";
  const fallbackKey = buildAccountMessageKey({
    accountId: params.accountId,
    messageId: replyToId,
  });
  if (!entry) {
    if (fallbackKey) {
      entry = replyRouteByAccountMessage.get(fallbackKey);
      if (entry) {
        matchType = "account-message-fallback";
      }
    }
  }
  if (!entry) {
    return null;
  }
  if (nowMs - entry.createdAtMs > REPLY_ROUTE_TTL_MS) {
    replyRouteIndex.delete(key);
    if (fallbackKey) {
      replyRouteByAccountMessage.delete(fallbackKey);
    }
    return null;
  }
  return {
    agentId: entry.agentId,
    accountId: entry.accountId,
    sessionKey: entry.sessionKey,
    mainSessionKey: entry.mainSessionKey,
    chatId: entry.chatId,
    matchType,
  };
}

export function clearWebReplyRouteIndexForTests() {
  replyRouteIndex.clear();
  replyRouteByAccountMessage.clear();
}
