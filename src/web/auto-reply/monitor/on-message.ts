import { execFile } from "node:child_process";
import path from "node:path";
import { resolveChunkMode, resolveTextChunkLimit } from "../../../auto-reply/chunk.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { loadConfig } from "../../../config/config.js";
import { resolveMarkdownTableMode } from "../../../config/markdown-tables.js";
import { logVerbose } from "../../../globals.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { buildGroupHistoryKey } from "../../../routing/session-key.js";
import { normalizeE164 } from "../../../utils.js";
import { deliverWebReply } from "../deliver-reply.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import { runGoogleDirectIntent } from "./google-direct-gog.js";
import { detectGoogleDirectIntent } from "./google-intent.js";
import type { GroupHistoryEntry } from "./group-gating.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";
import {
  rememberWebReplyRouteForOutboundMessages,
  resolveWebReplyRouteByMessageId,
} from "./reply-route-index.js";
import {
  isTmuxRelayTargetForSession,
  parseTmuxRelayTargetFromText,
  type TmuxRelayTarget,
} from "./tmux-relay-target.js";

const TMUX_SESSION_KEY_MARKER = ":tmux:";

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

async function hasLocalTmuxSession(params: { sessionName: string; env: NodeJS.ProcessEnv }) {
  const socketPath = resolveTmuxSocketPath(params.env);
  return await new Promise<{ exists: boolean; socketPath: string; error?: string }>((resolve) => {
    execFile(
      "tmux",
      ["-S", socketPath, "has-session", "-t", params.sessionName],
      { encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ exists: true, socketPath });
          return;
        }
        const stderrText = String(stderr ?? "").trim();
        const message = stderrText || String(error.message ?? error);
        resolve({ exists: false, socketPath, error: message });
      },
    );
  });
}

export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("../../../logging.js"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
  account: { authDir?: string; accountId?: string };
}) {
  const processForRoute = async (
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      tmuxRelayTarget?: TmuxRelayTarget;
    },
  ) =>
    processMessage({
      cfg: params.cfg,
      msg,
      route,
      groupHistoryKey,
      groupHistories: params.groupHistories,
      groupMemberNames: params.groupMemberNames,
      connectionId: params.connectionId,
      verbose: params.verbose,
      maxMediaBytes: params.maxMediaBytes,
      replyResolver: params.replyResolver,
      replyLogger: params.replyLogger,
      backgroundTasks: params.backgroundTasks,
      rememberSentText: params.echoTracker.rememberText,
      echoHas: params.echoTracker.has,
      echoForget: params.echoTracker.forget,
      buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
      groupHistory: opts?.groupHistory,
      suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
      tmuxRelayTarget: opts?.tmuxRelayTarget,
    });

  return async (msg: WebInboundMsg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    // Fresh config for bindings lookup; other routing inputs are payload-derived.
    const defaultRoute = resolveAgentRoute({
      cfg: loadConfig(),
      channel: "whatsapp",
      accountId: msg.accountId,
      peer: {
        kind: msg.chatType === "group" ? "group" : "direct",
        id: peerId,
      },
    });
    let replyRouteOverride = resolveWebReplyRouteByMessageId({
      accountId: msg.accountId,
      chatId: msg.chatId,
      replyToId: msg.replyToId,
    });
    let tmuxRelayTarget: TmuxRelayTarget | undefined;
    if (replyRouteOverride) {
      const tmuxSessionName = resolveTmuxSessionName(replyRouteOverride.sessionKey);
      if (tmuxSessionName) {
        const replyBodyTmuxTarget = parseTmuxRelayTargetFromText(msg.replyToBody);
        const hintedTmuxTarget = isTmuxRelayTargetForSession(
          replyRouteOverride.tmuxRelayTarget,
          tmuxSessionName,
        )
          ? replyRouteOverride.tmuxRelayTarget
          : isTmuxRelayTargetForSession(replyBodyTmuxTarget, tmuxSessionName)
            ? (replyBodyTmuxTarget ?? undefined)
            : undefined;
        const tmuxSession = await hasLocalTmuxSession({
          sessionName: tmuxSessionName,
          env: process.env,
        });
        if (!tmuxSession.exists) {
          if (hintedTmuxTarget?.host) {
            tmuxRelayTarget = hintedTmuxTarget;
            params.replyLogger.info(
              {
                replyToId: msg.replyToId,
                accountId: msg.accountId,
                chatId: msg.chatId,
                sessionKey: replyRouteOverride.sessionKey,
                tmuxSessionName,
                tmuxHost: hintedTmuxTarget.host,
                tmuxSocketPath: hintedTmuxTarget.socketPath,
                localTmuxSocketPath: tmuxSession.socketPath,
                tmuxError: tmuxSession.error ?? null,
              },
              "web reply-route tmux target not local; using node relay target",
            );
          } else {
            params.replyLogger.info(
              {
                replyToId: msg.replyToId,
                accountId: msg.accountId,
                chatId: msg.chatId,
                skippedSessionKey: replyRouteOverride.sessionKey,
                tmuxSessionName,
                tmuxSocketPath: tmuxSession.socketPath,
                tmuxError: tmuxSession.error ?? null,
              },
              "web reply-route tmux target not local; using default route",
            );
            replyRouteOverride = null;
          }
        } else {
          tmuxRelayTarget = hintedTmuxTarget;
        }
      }
    }
    const route = replyRouteOverride
      ? {
          ...defaultRoute,
          agentId: replyRouteOverride.agentId,
          accountId: replyRouteOverride.accountId,
          sessionKey: replyRouteOverride.sessionKey,
          mainSessionKey: replyRouteOverride.mainSessionKey,
        }
      : defaultRoute;
    if (replyRouteOverride) {
      params.replyLogger.info(
        {
          replyToId: msg.replyToId,
          accountId: msg.accountId,
          chatId: msg.chatId,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          matchType: replyRouteOverride.matchType,
          tmuxRelayHost: tmuxRelayTarget?.host ?? null,
        },
        "web reply-route hit",
      );
      logVerbose(
        `Routing WhatsApp reply via outbound reference ${msg.replyToId}: agent ${route.agentId}, session ${route.sessionKey}`,
      );
    } else if (msg.replyToId) {
      params.replyLogger.info(
        {
          replyToId: msg.replyToId,
          accountId: msg.accountId,
          chatId: msg.chatId,
          fallbackSessionKey: defaultRoute.sessionKey,
          fallbackAgentId: defaultRoute.agentId,
        },
        "web reply-route miss; using default route",
      );
    }
    const groupHistoryKey =
      msg.chatType === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;

    // Same-phone mode logging retained
    if (msg.from === msg.to) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.body);
      return;
    }

    if (msg.chatType === "group") {
      const metaCtx = {
        From: msg.from,
        To: msg.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.groupSubject,
        SenderName: msg.senderName,
        SenderId: msg.senderJid?.trim() || msg.senderE164,
        SenderE164: msg.senderE164,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
      updateLastRouteInBackground({
        cfg: params.cfg,
        backgroundTasks: params.backgroundTasks,
        storeAgentId: route.agentId,
        sessionKey: route.sessionKey,
        channel: "whatsapp",
        to: conversationId,
        accountId: route.accountId,
        ctx: metaCtx,
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });

      const gating = applyGroupGating({
        cfg: params.cfg,
        msg,
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig: params.baseMentionConfig,
        authDir: params.account.authDir,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger,
      });
      if (!gating.shouldProcess) {
        return;
      }
    } else {
      // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
      if (!msg.senderE164 && peerId && peerId.startsWith("+")) {
        msg.senderE164 = normalizeE164(peerId) ?? msg.senderE164;
      }
    }

    // Broadcast groups: when we'd reply anyway, run multiple agents.
    // Does not bypass group mention/activation gating above.
    if (
      !replyRouteOverride &&
      (await maybeBroadcastMessage({
        cfg: params.cfg,
        msg,
        peerId,
        route,
        groupHistoryKey,
        groupHistories: params.groupHistories,
        processMessage: processForRoute,
      }))
    ) {
      return;
    }

    const directGoogleIntent = detectGoogleDirectIntent(msg.body);
    if (directGoogleIntent) {
      const textLimit = resolveTextChunkLimit(params.cfg, "whatsapp");
      const chunkMode = resolveChunkMode(params.cfg, "whatsapp", route.accountId);
      const tableMode = resolveMarkdownTableMode({
        cfg: params.cfg,
        channel: "whatsapp",
        accountId: route.accountId,
      });
      const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, route.agentId);
      try {
        const direct = await runGoogleDirectIntent({
          cfg: params.cfg,
          intent: directGoogleIntent,
        });
        const sentMessageIds = await deliverWebReply({
          replyResult: { text: direct.text },
          msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          tableMode,
        });
        if (sentMessageIds.length > 0) {
          rememberWebReplyRouteForOutboundMessages({
            accountId: route.accountId,
            chatId: msg.chatId,
            route,
            ...(tmuxRelayTarget ? { tmuxRelayTarget } : {}),
            messageIds: sentMessageIds,
          });
        }
      } catch (err) {
        const sentMessageIds = await deliverWebReply({
          replyResult: {
            text: `⚠️ Google Tasks/Calendar request failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          msg,
          mediaLocalRoots,
          maxMediaBytes: params.maxMediaBytes,
          textLimit,
          chunkMode,
          replyLogger: params.replyLogger,
          connectionId: params.connectionId,
          tableMode,
        });
        if (sentMessageIds.length > 0) {
          rememberWebReplyRouteForOutboundMessages({
            accountId: route.accountId,
            chatId: msg.chatId,
            route,
            ...(tmuxRelayTarget ? { tmuxRelayTarget } : {}),
            messageIds: sentMessageIds,
          });
        }
      }
      return;
    }

    await processForRoute(msg, route, groupHistoryKey, { tmuxRelayTarget });
  };
}
