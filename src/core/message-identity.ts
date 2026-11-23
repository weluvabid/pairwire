import type { ChatMessage } from "./types.js";

/** Fields that must remain identical when a message ID is retransmitted. */
export function hasSameMessageIdentity(existing: ChatMessage, incoming: ChatMessage): boolean {
  return existing.id === incoming.id
    && existing.conversationId === incoming.conversationId
    && existing.fromPeerId === incoming.fromPeerId
    && existing.toPeerId === incoming.toPeerId
    && existing.text === incoming.text
    && existing.createdAt === incoming.createdAt
    && existing.direction === incoming.direction;
}
