import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveIdentityNamePrefix } from "../../../agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../../auto-reply/chunk.js";
import { shouldComputeCommandAuthorized } from "../../../auto-reply/command-detection.js";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../auto-reply/envelope.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import {
  buildHistoryContextFromEntries,
  type HistoryEntry,
} from "../../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { toLocationContext } from "../../../channels/location.js";
import { createReplyPrefixOptions } from "../../../channels/reply-prefix.js";
import type { loadConfig } from "../../../config/config.js";
import { resolveMarkdownTableMode } from "../../../config/markdown-tables.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "../../../config/sessions.js";
import { callGateway } from "../../../gateway/call.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import type { getChildLogger } from "../../../logging.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import type { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveNodeIdFromCandidates } from "../../../shared/node-match.js";
import { jidToE164, normalizeE164, sleep } from "../../../utils.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog, whatsappOutboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { formatGroupMembers } from "./group-members.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import { rememberWebReplyRouteForOutboundMessages } from "./reply-route-index.js";
import { normalizeTmuxRelayHostLabel } from "./tmux-relay-target.js";
import type { TmuxRelayTarget } from "./tmux-relay-target.js";

const TMUX_SESSION_KEY_MARKER = ":tmux:";
const TMUX_PROMPT_ENTER_DELAY_MS = 500;

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

function normalizeAllowFromE164(values: Array<string | number> | undefined): string[] {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && entry !== "*")
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveTmuxSessionName(sessionKey: string | undefined): string | null {
  const raw = sessionKey?.trim() ?? "";
  if (!raw) {
    return null;
  }
  const markerIndex = raw.indexOf(TMUX_SESSION_KEY_MARKER);
  if (markerIndex < 0) {
    return null;
  }
  const sessionName = raw.slice(markerIndex + TMUX_SESSION_KEY_MARKER.length).trim();
  return sessionName || null;
}

function resolveTmuxSocketPath(env: NodeJS.ProcessEnv): string {
  const configuredSocketDir = (env.OPENCLAW_TMUX_SOCKET_DIR ?? env.CLAWDBOT_TMUX_SOCKET_DIR ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (configuredSocketDir) {
    if (configuredSocketDir.endsWith(".sock")) {
      return configuredSocketDir;
    }
    return path.join(configuredSocketDir, "openclaw.sock");
  }
  const tmpDir = (env.TMPDIR ?? "/tmp").trim();
  return path.join(tmpDir, "openclaw-tmux-sockets", "openclaw.sock");
}

async function runExecFile(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const stderrText = String(stderr ?? "").trim();
      const message = stderrText || formatError(error);
      reject(new Error(message));
    });
  });
}

function buildTmuxRelayPrompt(params: {
  body: string | undefined;
  combinedBody: string;
  mediaPath: string | undefined;
  mediaType: string | undefined;
  mediaFileName: string | undefined;
}): string | null {
  const basePrompt = params.body?.trim() || params.combinedBody.trim();
  if (!basePrompt) {
    return null;
  }
  const metadataTokens: string[] = [];
  const appendMetadata = (key: string, value: string | undefined): void => {
    const normalized = value?.trim();
    if (!normalized) {
      return;
    }
    metadataTokens.push(`[${key}=${JSON.stringify(normalized)}]`);
  };
  appendMetadata("media_path", params.mediaPath);
  appendMetadata("media_type", params.mediaType);
  appendMetadata("media_file_name", params.mediaFileName);
  return metadataTokens.length > 0 ? `${basePrompt} ${metadataTokens.join(" ")}` : basePrompt;
}

type NodeSummary = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  commands?: string[];
};

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function isLocalHostLabel(host: string | undefined): boolean {
  const label = normalizeToken(host).toLowerCase();
  if (!label) {
    return false;
  }
  const local = os.hostname().trim().toLowerCase();
  if (!local) {
    return false;
  }
  return label === local || label === local.split(".")[0];
}

function buildTmuxAttachLabel(params: {
  host?: string;
  socketPath: string;
  sessionName: string;
}): string {
  const attachCommand = `tmux -S ${params.socketPath} attach -t ${params.sessionName}`;
  const host = normalizeToken(params.host);
  if (!host) {
    return `[codex in '${attachCommand}']`;
  }
  return `[codex on host '${host}' in '${attachCommand}']`;
}

async function resolveRelayNode(params: {
  cfg: ReturnType<typeof loadConfig>;
  host: string;
}): Promise<{ nodeId: string; node: NodeSummary }> {
  const listResult = await callGateway<{ nodes?: NodeSummary[] }>({
    method: "node.list",
    params: {},
    config: params.cfg,
    timeoutMs: 10_000,
  });
  const nodes = Array.isArray(listResult.nodes) ? listResult.nodes : [];
  const nodeId = resolveNodeIdFromCandidates(
    nodes.map((node) => ({
      nodeId: node.nodeId,
      displayName: node.displayName,
      remoteIp: node.remoteIp,
    })),
    params.host,
  );
  const node = nodes.find((entry) => entry.nodeId === nodeId);
  if (!node) {
    throw new Error(`unknown node: ${params.host}`);
  }
  if (!node.connected) {
    throw new Error(`node not connected: ${params.host}`);
  }
  if (!Array.isArray(node.commands) || !node.commands.includes("system.run")) {
    throw new Error(`node does not support system.run: ${params.host}`);
  }
  return { nodeId, node };
}

async function runNodeSystemRun(params: {
  cfg: ReturnType<typeof loadConfig>;
  nodeId: string;
  command: string[];
}): Promise<void> {
  const result = await callGateway<{ payload?: Record<string, unknown> }>({
    method: "node.invoke",
    params: {
      nodeId: params.nodeId,
      command: "system.run",
      params: {
        command: params.command,
        timeoutMs: 20_000,
      },
      timeoutMs: 30_000,
      idempotencyKey: randomUUID(),
    },
    config: params.cfg,
    timeoutMs: 40_000,
  });
  const payload = result.payload && typeof result.payload === "object" ? result.payload : {};
  const timedOut = payload.timedOut === true;
  const success = payload.success === true;
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
  if (timedOut) {
    throw new Error("node run timed out");
  }
  if (!success && exitCode !== null && exitCode !== 0) {
    const stderr =
      typeof payload.stderr === "string" && payload.stderr.trim() ? payload.stderr.trim() : "";
    const error =
      typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "";
    throw new Error(stderr || error || `node run exit ${exitCode}`);
  }
}

async function relayTmuxPromptViaNode(params: {
  cfg: ReturnType<typeof loadConfig>;
  nodeId: string;
  tmuxSocketPath: string;
  tmuxSessionName: string;
  prompt: string;
}) {
  const tmuxTarget = `${params.tmuxSessionName}:0.0`;
  await runNodeSystemRun({
    cfg: params.cfg,
    nodeId: params.nodeId,
    command: [
      "tmux",
      "-S",
      params.tmuxSocketPath,
      "send-keys",
      "-t",
      tmuxTarget,
      "-l",
      "--",
      params.prompt,
    ],
  });
  await sleep(TMUX_PROMPT_ENTER_DELAY_MS);
  await runNodeSystemRun({
    cfg: params.cfg,
    nodeId: params.nodeId,
    command: ["tmux", "-S", params.tmuxSocketPath, "send-keys", "-t", tmuxTarget, "Enter"],
  });
}

async function resolveWhatsAppCommandAuthorized(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const isGroup = params.msg.chatType === "group";
  const senderE164 = normalizeE164(
    isGroup ? (params.msg.senderE164 ?? "") : (params.msg.senderE164 ?? params.msg.from ?? ""),
  );
  if (!senderE164) {
    return false;
  }

  const configuredAllowFrom = params.cfg.channels?.whatsapp?.allowFrom ?? [];
  const configuredGroupAllowFrom =
    params.cfg.channels?.whatsapp?.groupAllowFrom ??
    (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);

  if (isGroup) {
    if (!configuredGroupAllowFrom || configuredGroupAllowFrom.length === 0) {
      return false;
    }
    if (configuredGroupAllowFrom.some((v) => String(v).trim() === "*")) {
      return true;
    }
    return normalizeAllowFromE164(configuredGroupAllowFrom).includes(senderE164);
  }

  const storeAllowFrom = await readChannelAllowFromStore(
    "whatsapp",
    process.env,
    params.msg.accountId,
  ).catch(() => []);
  const combinedAllowFrom = Array.from(
    new Set([...(configuredAllowFrom ?? []), ...storeAllowFrom]),
  );
  const allowFrom =
    combinedAllowFrom.length > 0
      ? combinedAllowFrom
      : params.msg.selfE164
        ? [params.msg.selfE164]
        : [];
  if (allowFrom.some((v) => String(v).trim() === "*")) {
    return true;
  }
  return normalizeAllowFromE164(allowFrom).includes(senderE164);
}

export async function processMessage(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
  tmuxRelayTarget?: TmuxRelayTarget;
}) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: params.route.sessionKey,
  });
  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let shouldClearGroupHistory = false;

  if (params.msg.chatType === "group") {
    const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // Send ack reaction immediately upon message receipt (post-gating)
  maybeSendAckReaction({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    conversationId,
    verbose: params.verbose,
    accountId: params.route.accountId,
    info: params.replyLogger.info.bind(params.replyLogger),
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const correlationId = params.msg.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: params.msg.chatType === "group" ? conversationId : params.msg.from,
      to: params.msg.to,
      body: elide(combinedBody, 240),
      mediaType: params.msg.mediaType ?? null,
      mediaPath: params.msg.mediaPath ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const dmRouteTarget =
    params.msg.chatType !== "group"
      ? (() => {
          if (params.msg.senderE164) {
            return normalizeE164(params.msg.senderE164);
          }
          // In direct chats, `msg.from` is already the canonical conversation id.
          if (params.msg.from.includes("@")) {
            return jidToE164(params.msg.from);
          }
          return normalizeE164(params.msg.from);
        })()
      : undefined;

  const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
  const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
  let didLogHeartbeatStrip = false;
  let didSendReply = false;
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg })
    : undefined;
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const isSelfChat =
    params.msg.chatType !== "group" &&
    Boolean(params.msg.selfE164) &&
    normalizeE164(params.msg.from) === normalizeE164(params.msg.selfE164 ?? "");
  const responsePrefix =
    prefixOptions.responsePrefix ??
    (configuredResponsePrefix === undefined && isSelfChat
      ? (resolveIdentityNamePrefix(params.cfg, params.route.agentId) ?? "[openclaw]")
      : undefined);

  const inboundHistory =
    params.msg.chatType === "group"
      ? (params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? []).map(
          (entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }),
        )
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: params.msg.body,
    InboundHistory: inboundHistory,
    RawBody: params.msg.body,
    CommandBody: params.msg.body,
    From: params.msg.from,
    To: params.msg.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    MessageSid: params.msg.id,
    ReplyToId: params.msg.replyToId,
    ReplyToBody: params.msg.replyToBody,
    ReplyToSender: params.msg.replyToSender,
    MediaPath: params.msg.mediaPath,
    MediaUrl: params.msg.mediaUrl,
    MediaType: params.msg.mediaType,
    ChatType: params.msg.chatType,
    ConversationLabel: params.msg.chatType === "group" ? conversationId : params.msg.from,
    GroupSubject: params.msg.groupSubject,
    GroupMembers: formatGroupMembers({
      participants: params.msg.groupParticipants,
      roster: params.groupMemberNames.get(params.groupHistoryKey),
      fallbackE164: params.msg.senderE164,
    }),
    SenderName: params.msg.senderName,
    SenderId: params.msg.senderJid?.trim() || params.msg.senderE164,
    SenderE164: params.msg.senderE164,
    CommandAuthorized: commandAuthorized,
    WasMentioned: params.msg.wasMentioned,
    ...(params.msg.location ? toLocationContext(params.msg.location) : {}),
    Provider: "whatsapp",
    Surface: "whatsapp",
    OriginatingChannel: "whatsapp",
    OriginatingTo: params.msg.from,
  });

  if (dmRouteTarget) {
    updateLastRouteInBackground({
      cfg: params.cfg,
      backgroundTasks: params.backgroundTasks,
      storeAgentId: params.route.agentId,
      sessionKey: params.route.mainSessionKey,
      channel: "whatsapp",
      to: dmRouteTarget,
      accountId: params.route.accountId,
      ctx: ctxPayload,
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

  const metaTask = recordSessionMetaFromInbound({
    storePath,
    sessionKey: params.route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    params.replyLogger.warn(
      {
        error: formatError(err),
        storePath,
        sessionKey: params.route.sessionKey,
      },
      "failed updating session meta",
    );
  });
  trackBackgroundTask(params.backgroundTasks, metaTask);

  const tmuxSessionName = resolveTmuxSessionName(params.route.sessionKey);
  if (tmuxSessionName) {
    const targetOverride =
      params.tmuxRelayTarget &&
      normalizeToken(params.tmuxRelayTarget.sessionName) === tmuxSessionName
        ? params.tmuxRelayTarget
        : undefined;
    const relayPrompt = buildTmuxRelayPrompt({
      body: params.msg.body,
      combinedBody,
      mediaPath: params.msg.mediaPath,
      mediaType: params.msg.mediaType,
      mediaFileName: params.msg.mediaFileName,
    });
    if (relayPrompt) {
      const tmuxHost = targetOverride
        ? normalizeTmuxRelayHostLabel(targetOverride.host)
        : undefined;
      const shouldUseNodeRelay = Boolean(tmuxHost && !isLocalHostLabel(tmuxHost));
      const tmuxSocketPath = targetOverride?.socketPath ?? resolveTmuxSocketPath(process.env);
      try {
        if (shouldUseNodeRelay && tmuxHost) {
          const { nodeId } = await resolveRelayNode({ cfg: params.cfg, host: tmuxHost });
          await relayTmuxPromptViaNode({
            cfg: params.cfg,
            nodeId,
            tmuxSocketPath,
            tmuxSessionName,
            prompt: relayPrompt,
          });
        } else {
          const tmuxTarget = `${tmuxSessionName}:0.0`;
          await runExecFile("tmux", [
            "-S",
            tmuxSocketPath,
            "send-keys",
            "-t",
            tmuxTarget,
            "-l",
            "--",
            relayPrompt,
          ]);
          await sleep(TMUX_PROMPT_ENTER_DELAY_MS);
          await runExecFile("tmux", ["-S", tmuxSocketPath, "send-keys", "-t", tmuxTarget, "Enter"]);
        }
      } catch (err) {
        const errorReply = `⚠️ Failed forwarding to tmux session ${tmuxSessionName}: ${formatError(err)}`;
        const sentErrorMessageIds = await deliverWebReply({
          replyResult: { text: errorReply },
          msg: params.msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          tableMode,
        });
        if (sentErrorMessageIds.length > 0) {
          rememberWebReplyRouteForOutboundMessages({
            accountId: params.route.accountId,
            chatId: params.msg.chatId,
            route: params.route,
            ...(targetOverride ? { tmuxRelayTarget: targetOverride } : {}),
            messageIds: sentErrorMessageIds,
          });
        }
        if (shouldClearGroupHistory) {
          params.groupHistories.set(params.groupHistoryKey, []);
        }
        params.replyLogger.warn(
          {
            error: formatError(err),
            sessionKey: params.route.sessionKey,
            tmuxSessionName,
            tmuxSocketPath,
            tmuxHost: tmuxHost ?? null,
          },
          "failed deterministic tmux relay",
        );
        return sentErrorMessageIds.length > 0;
      }

      const ackPrefix = buildTmuxAttachLabel({
        host: tmuxHost,
        socketPath: tmuxSocketPath,
        sessionName: tmuxSessionName,
      });
      const ackText = `${ackPrefix} Forwarded.`;
      const sentAckMessageIds = await deliverWebReply({
        replyResult: { text: ackText },
        msg: params.msg,
        mediaLocalRoots,
        maxMediaBytes: params.maxMediaBytes,
        textLimit,
        chunkMode,
        replyLogger: params.replyLogger,
        connectionId: params.connectionId,
        tableMode,
      });
      if (sentAckMessageIds.length > 0) {
        rememberWebReplyRouteForOutboundMessages({
          accountId: params.route.accountId,
          chatId: params.msg.chatId,
          route: params.route,
          ...(targetOverride ? { tmuxRelayTarget: targetOverride } : {}),
          messageIds: sentAckMessageIds,
        });
      }
      params.rememberSentText(ackText, {
        combinedBody,
        combinedBodySessionKey: params.route.sessionKey,
        logVerboseMessage: true,
      });
      params.replyLogger.info(
        {
          sessionKey: params.route.sessionKey,
          tmuxSessionName,
          tmuxSocketPath,
          tmuxHost: tmuxHost ?? null,
        },
        "deterministic tmux relay delivered",
      );
      if (shouldClearGroupHistory) {
        params.groupHistories.set(params.groupHistoryKey, []);
      }
      return sentAckMessageIds.length > 0;
    }
  }

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: params.cfg,
    replyResolver: params.replyResolver,
    dispatcherOptions: {
      ...prefixOptions,
      responsePrefix,
      onHeartbeatStrip: () => {
        if (!didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
        }
      },
      deliver: async (payload: ReplyPayload, info) => {
        const sentMessageIds = await deliverWebReply({
          replyResult: payload,
          msg: params.msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          // Tool + block updates are noisy; skip their log lines.
          skipLog: info.kind !== "final",
          tableMode,
        });
        if (sentMessageIds.length > 0) {
          rememberWebReplyRouteForOutboundMessages({
            accountId: params.route.accountId,
            chatId: params.msg.chatId,
            route: params.route,
            messageIds: sentMessageIds,
          });
        }
        didSendReply = true;
        if (info.kind === "tool") {
          params.rememberSentText(payload.text, {});
          return;
        }
        const shouldLog = info.kind === "final" && payload.text ? true : undefined;
        params.rememberSentText(payload.text, {
          combinedBody,
          combinedBodySessionKey: params.route.sessionKey,
          logVerboseMessage: shouldLog,
        });
        if (info.kind === "final") {
          const fromDisplay =
            params.msg.chatType === "group" ? conversationId : (params.msg.from ?? "unknown");
          const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
          whatsappOutboundLog.info(`Auto-replied to ${fromDisplay}${hasMedia ? " (media)" : ""}`);
          if (shouldLogVerbose()) {
            const preview = payload.text != null ? elide(payload.text, 400) : "<media>";
            whatsappOutboundLog.debug(`Reply body: ${preview}${hasMedia ? " (media)" : ""}`);
          }
        }
      },
      onError: (err, info) => {
        const label =
          info.kind === "tool"
            ? "tool update"
            : info.kind === "block"
              ? "block update"
              : "auto-reply";
        whatsappOutboundLog.error(
          `Failed sending web ${label} to ${params.msg.from ?? conversationId}: ${formatError(err)}`,
        );
      },
      onReplyStart: params.msg.sendComposing,
    },
    replyOptions: {
      disableBlockStreaming:
        typeof params.cfg.channels?.whatsapp?.blockStreaming === "boolean"
          ? !params.cfg.channels.whatsapp.blockStreaming
          : undefined,
      onModelSelected,
    },
  });

  if (!queuedFinal) {
    if (shouldClearGroupHistory) {
      params.groupHistories.set(params.groupHistoryKey, []);
    }
    logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
    return false;
  }

  if (shouldClearGroupHistory) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return didSendReply;
}
