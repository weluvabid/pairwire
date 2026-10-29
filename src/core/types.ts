export const PROTOCOL_NAME = "pairwire" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MAX_TEXT_LENGTH = 8_000;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_SIGNALING_CHARS = 256 * 1024;

export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type MessageStatus = "pending" | "sending" | "sent" | "delivered" | "failed";
export type MessageDirection = "incoming" | "outgoing";

export interface PeerIdentity {
  id: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  fromPeerId: string;
  toPeerId: string;
  text: string;
  createdAt: number;
  direction: MessageDirection;
  status: MessageStatus;
}

export interface WireMessage {
  protocol: typeof PROTOCOL_NAME;
  version: typeof PROTOCOL_VERSION;
  type: "message";
  id: string;
  conversationId: string;
  fromPeerId: string;
  toPeerId: string;
  text: string;
  createdAt: number;
}

export interface WireAcknowledgement {
  protocol: typeof PROTOCOL_NAME;
  version: typeof PROTOCOL_VERSION;
  type: "ack";
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  persistedAt: number;
}

export type WireFrame = WireMessage | WireAcknowledgement;

export interface SignalingPayload {
  type: "pairwire-invitation" | "pairwire-response";
  version: typeof PROTOCOL_VERSION;
  peer: PeerIdentity;
  description: RTCSessionDescriptionInit;
}

export interface PeerRecord extends PeerIdentity {
  lastSeenAt: number;
  conversationId: string;
}

export interface ConversationRecord {
  id: string;
  peerId: string;
  updatedAt: number;
  lastMessage?: string;
}

export interface SettingsRecord {
  key: string;
  value: string;
}

export function conversationIdFor(firstPeerId: string, secondPeerId: string): string {
  return [firstPeerId, secondPeerId].sort().join(":");
}
