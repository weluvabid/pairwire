import type { ChatMessage } from "../../core/types.js";
import { initials, isoTime, prettyTime, statusLabel } from "../../utils/formatting.js";

export function Message({ message, peerName, onRetry, retryBusy }: { message: ChatMessage; peerName: string; onRetry(): void; retryBusy: boolean }) {
  const outgoing = message.direction === "outgoing";
  return <div class={`chat ${outgoing ? "chat-end" : "chat-start"}`}>
    <div class="chat-image avatar placeholder message-avatar"><div><span>{outgoing ? "Y" : initials(peerName)}</span></div></div>
    <div class="chat-header">{outgoing ? "You" : peerName}<time dateTime={isoTime(message.createdAt)}>{prettyTime(message.createdAt)}</time></div>
    <div class={`chat-bubble ${outgoing ? "chat-bubble-primary" : ""}`}>{message.text}</div>
    {outgoing && <div class="chat-footer mt-1"><span class={`badge badge-xs ${message.status === "failed" ? "badge-error" : message.status === "delivered" ? "badge-success" : "badge-ghost"}`}>{statusLabel(message.status)}</span>{message.status === "failed" && <button class="btn btn-ghost btn-xs" type="button" disabled={retryBusy} onClick={onRetry}>Retry</button>}</div>}
  </div>;
}
