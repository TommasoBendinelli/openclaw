import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
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

type PersistedReplyRouteEntry = ReplyRouteEntry & {
  messageId: string;
};

type PersistedReplyRouteDocument = {
  version: 1;
  savedAtMs: number;
  entries: PersistedReplyRouteEntry[];
};

const REPLY_ROUTE_TTL_MS = 21 * 24 * 60 * 60 * 1000;
const REPLY_ROUTE_MAX_ENTRIES = 20_000;
const REPLY_ROUTE_PERSIST_VERSION = 1 as const;
const REPLY_ROUTE_FLUSH_DEBOUNCE_MS = 250;
const replyRouteIndex = new Map<string, ReplyRouteEntry>();
const replyRouteByAccountMessage = new Map<string, ReplyRouteEntry>();
let didAttemptLoadReplyRouteIndex = false;
let persistFlushTimer: NodeJS.Timeout | null = null;
let persistFlushInFlight: Promise<void> | null = null;
let persistDirty = false;

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

function parseReplyRouteKey(key: string): {
  accountId: string;
  chatId: string;
  messageId: string;
} | null {
  const [accountId, chatId, messageId] = key.split("\u0001");
  if (!accountId || !chatId || !messageId) {
    return null;
  }
  return { accountId, chatId, messageId };
}

function resolveReplyRouteIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_REPLY_ROUTE_INDEX_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveStateDir(env), "cache", "whatsapp-reply-route-index.json");
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

function toPersistedEntries(nowMs: number): PersistedReplyRouteEntry[] {
  const entries: PersistedReplyRouteEntry[] = [];
  for (const [key, entry] of replyRouteIndex) {
    if (nowMs - entry.createdAtMs > REPLY_ROUTE_TTL_MS) {
      continue;
    }
    const parsed = parseReplyRouteKey(key);
    if (!parsed) {
      continue;
    }
    entries.push({
      messageId: parsed.messageId,
      accountId: entry.accountId,
      chatId: entry.chatId,
      agentId: entry.agentId,
      sessionKey: entry.sessionKey,
      mainSessionKey: entry.mainSessionKey,
      createdAtMs: entry.createdAtMs,
    });
  }
  if (entries.length > REPLY_ROUTE_MAX_ENTRIES) {
    return entries.slice(entries.length - REPLY_ROUTE_MAX_ENTRIES);
  }
  return entries;
}

function persistReplyRouteIndexSoon() {
  persistDirty = true;
  if (persistFlushTimer) {
    return;
  }
  persistFlushTimer = setTimeout(() => {
    persistFlushTimer = null;
    void flushReplyRouteIndexToDisk();
  }, REPLY_ROUTE_FLUSH_DEBOUNCE_MS);
  persistFlushTimer.unref?.();
}

async function flushReplyRouteIndexToDisk(): Promise<void> {
  if (persistFlushInFlight) {
    return persistFlushInFlight;
  }
  const nowMs = Date.now();
  pruneExpired(nowMs);
  const entries = toPersistedEntries(nowMs);
  const document: PersistedReplyRouteDocument = {
    version: REPLY_ROUTE_PERSIST_VERSION,
    savedAtMs: nowMs,
    entries,
  };
  const targetPath = resolveReplyRouteIndexPath(process.env);
  persistDirty = false;
  persistFlushInFlight = (async () => {
    try {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.tmp-${process.pid}-${nowMs}`;
      await fsp.writeFile(tempPath, JSON.stringify(document), "utf8");
      await fsp.rename(tempPath, targetPath);
    } catch {
      persistDirty = true;
    } finally {
      persistFlushInFlight = null;
      if (persistDirty) {
        persistReplyRouteIndexSoon();
      }
    }
  })();
  return persistFlushInFlight;
}

function loadReplyRouteIndexFromDiskOnce(nowMs: number) {
  if (didAttemptLoadReplyRouteIndex) {
    return;
  }
  didAttemptLoadReplyRouteIndex = true;
  const filePath = resolveReplyRouteIndexPath(process.env);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const entriesRaw = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) {
    return;
  }
  for (const item of entriesRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Partial<PersistedReplyRouteEntry>;
    const accountId = normalizeToken(candidate.accountId);
    const chatId = normalizeToken(candidate.chatId);
    const messageId = normalizeToken(candidate.messageId);
    const agentId = normalizeToken(candidate.agentId);
    const sessionKey = normalizeToken(candidate.sessionKey);
    const mainSessionKey = normalizeToken(candidate.mainSessionKey);
    const createdAtMs =
      typeof candidate.createdAtMs === "number" && Number.isFinite(candidate.createdAtMs)
        ? candidate.createdAtMs
        : Number.NaN;
    if (
      !accountId ||
      !chatId ||
      !messageId ||
      !agentId ||
      !sessionKey ||
      !mainSessionKey ||
      !Number.isFinite(createdAtMs)
    ) {
      continue;
    }
    if (nowMs - createdAtMs > REPLY_ROUTE_TTL_MS) {
      continue;
    }
    const key = buildReplyRouteKey({ accountId, chatId, messageId });
    if (!key) {
      continue;
    }
    const entry: ReplyRouteEntry = {
      accountId,
      chatId,
      agentId,
      sessionKey,
      mainSessionKey,
      createdAtMs,
    };
    replyRouteIndex.set(key, entry);
    const fallbackKey = buildAccountMessageKey({ accountId, messageId });
    if (fallbackKey) {
      replyRouteByAccountMessage.set(fallbackKey, entry);
    }
  }
  pruneExpired(nowMs);
  trimOverflow();
}

export function rememberWebReplyRouteForOutboundMessages(params: {
  accountId: string;
  chatId: string;
  route: Pick<ResolvedAgentRoute, "agentId" | "accountId" | "sessionKey" | "mainSessionKey">;
  messageIds: readonly string[];
  nowMs?: number;
}) {
  const nowMs = params.nowMs ?? Date.now();
  loadReplyRouteIndexFromDiskOnce(nowMs);
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
  persistReplyRouteIndexSoon();
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
  loadReplyRouteIndexFromDiskOnce(nowMs);
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

export function forgetWebReplyRouteByMessageId(params: {
  accountId: string;
  chatId: string;
  messageId: string | undefined;
  nowMs?: number;
}): boolean {
  const messageId = normalizeToken(params.messageId);
  if (!messageId) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  loadReplyRouteIndexFromDiskOnce(nowMs);
  const key = buildReplyRouteKey({
    accountId: params.accountId,
    chatId: params.chatId,
    messageId,
  });
  if (!key) {
    return false;
  }
  const existing = replyRouteIndex.get(key);
  if (!existing) {
    return false;
  }
  replyRouteIndex.delete(key);
  const fallbackKey = buildAccountMessageKey({
    accountId: params.accountId,
    messageId,
  });
  dropSecondaryIndexIfMatches({
    accountMessageKey: fallbackKey,
    entry: existing,
  });
  persistReplyRouteIndexSoon();
  return true;
}

export function clearWebReplyRouteIndexForTests() {
  if (persistFlushTimer) {
    clearTimeout(persistFlushTimer);
    persistFlushTimer = null;
  }
  replyRouteIndex.clear();
  replyRouteByAccountMessage.clear();
  didAttemptLoadReplyRouteIndex = true;
  persistDirty = false;
  persistFlushInFlight = null;
}

export async function flushWebReplyRouteIndexForTests() {
  if (persistFlushTimer) {
    clearTimeout(persistFlushTimer);
    persistFlushTimer = null;
  }
  await flushReplyRouteIndexToDisk();
}

export function resetWebReplyRouteIndexLoadStateForTests() {
  didAttemptLoadReplyRouteIndex = false;
}
