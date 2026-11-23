import type { ChatMessage, MessageStatus } from "../core/types.js";

const CONNECTION_LABELS: Record<string, string> = {
  new: "No active connection",
  connecting: "Establishing direct connection…",
  connected: "Connected directly",
  disconnected: "Connection interrupted",
  failed: "Connection failed",
  closed: "Connection closed",
};

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  pending: "Queued",
  sending: "Sending",
  sent: "Sent · waiting for receipt",
  delivered: "Delivered",
  failed: "Not sent",
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1
    ? parts[0]!.slice(0, 1)
    : `${parts[0]!.slice(0, 1)}${parts.at(-1)!.slice(0, 1)}`
  ).toLocaleUpperCase();
}

export function connectionDescription(state: string): string {
  return CONNECTION_LABELS[state] ?? CONNECTION_LABELS["new"]!;
}

export function prettyTime(timestamp: number): string {
  if (!isValidTimestamp(timestamp)) return "Unknown time";
  return TIME_FORMATTER.format(timestamp);
}

export function isoTime(timestamp: number): string | undefined {
  return isValidTimestamp(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

export function statusLabel(status: ChatMessage["status"]): string {
  return MESSAGE_STATUS_LABELS[status];
}

export function peerConnectionLabel(connected: boolean, state: string): string {
  if (connected) return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "failed") return "Connection failed";
  return "Disconnected";
}

export function countPendingByPeer(messages: readonly ChatMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.toPeerId, (counts.get(message.toPeerId) ?? 0) + 1);
  }
  return counts;
}
