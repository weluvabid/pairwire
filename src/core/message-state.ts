import type { MessageStatus } from "./types.js";

const validTransitions: Record<MessageStatus, ReadonlySet<MessageStatus>> = {
  pending: new Set(["sending", "failed", "delivered"]),
  sending: new Set(["sent", "pending", "failed", "delivered"]),
  sent: new Set(["pending", "failed", "delivered"]),
  delivered: new Set(),
  failed: new Set(["pending", "sending", "delivered"]),
};

export class InvalidMessageTransitionError extends Error {
  constructor(from: MessageStatus, to: MessageStatus) {
    super(`Invalid message state transition: ${from} -> ${to}`);
    this.name = "InvalidMessageTransitionError";
  }
}

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return from === to || validTransitions[from].has(to);
}

export function transitionMessage(from: MessageStatus, to: MessageStatus): MessageStatus {
  if (!canTransitionMessage(from, to)) throw new InvalidMessageTransitionError(from, to);
  return to;
}

export function isTerminalStatus(status: MessageStatus): boolean {
  return status === "delivered";
}
