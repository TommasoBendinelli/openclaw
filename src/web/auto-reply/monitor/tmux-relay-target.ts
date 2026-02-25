export type TmuxRelayTarget = {
  host?: string;
  socketPath: string;
  sessionName: string;
};

const CODEX_TMUX_LABEL_PATTERN =
  /\[codex(?:\s+on\s+host\s+'([^']+)')?\s+in\s+'tmux\s+-S\s+(.+?)\s+attach\s+-t\s+([^']+)'\]/i;

function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim();
}

export function normalizeTmuxRelayHostLabel(host: string | undefined | null): string {
  const normalized = normalizeToken(host);
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^([^:\s]+):\/.+$/);
  if (match && match[1]) {
    return match[1];
  }
  return normalized;
}

export function parseTmuxRelayTargetFromText(
  text: string | undefined | null,
): TmuxRelayTarget | null {
  const raw = normalizeToken(text);
  if (!raw) {
    return null;
  }
  const match = raw.match(CODEX_TMUX_LABEL_PATTERN);
  if (!match) {
    return null;
  }
  const host = normalizeTmuxRelayHostLabel(match[1]);
  const socketPath = normalizeToken(match[2]);
  const sessionName = normalizeToken(match[3]);
  if (!socketPath || !sessionName) {
    return null;
  }
  return host ? { host, socketPath, sessionName } : { socketPath, sessionName };
}

export function isTmuxRelayTargetForSession(
  target: TmuxRelayTarget | null | undefined,
  sessionName: string | undefined | null,
): boolean {
  const candidate = normalizeToken(target?.sessionName);
  const session = normalizeToken(sessionName);
  return Boolean(candidate && session && candidate === session);
}
