import {
  MAX_FRAME_BYTES,
  MAX_SIGNALING_CHARS,
  MAX_TEXT_LENGTH,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  conversationIdFor,
} from "./types.js";
import type {
  PeerIdentity,
  SignalingPayload,
  WireAcknowledgement,
  WireFrame,
  WireMessage,
} from "./types.js";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function createWireMessage(input: {
  id: string;
  fromPeerId: string;
  toPeerId: string;
  text: string;
  createdAt: number;
}): WireMessage {
  const text = input.text.trim();
  if (!text) throw new ProtocolError("Messages cannot be empty.");
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ProtocolError(`Messages must be ${MAX_TEXT_LENGTH.toLocaleString()} characters or fewer.`);
  }
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: "message",
    id: input.id,
    conversationId: conversationIdFor(input.fromPeerId, input.toPeerId),
    fromPeerId: input.fromPeerId,
    toPeerId: input.toPeerId,
    text,
    createdAt: input.createdAt,
  };
}

export function createAcknowledgement(input: {
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  persistedAt: number;
}): WireAcknowledgement {
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: "ack",
    messageId: input.messageId,
    fromPeerId: input.fromPeerId,
    toPeerId: input.toPeerId,
    persistedAt: input.persistedAt,
  };
}

export function encodeFrame(frame: WireFrame): string {
  const serialized = JSON.stringify(frame);
  if (new TextEncoder().encode(serialized).byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("The encoded message exceeds the frame size limit.");
  }
  return serialized;
}

export function decodeFrame(input: string): WireFrame {
  if (new TextEncoder().encode(input).byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("Incoming frame exceeds the size limit.");
  }

  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new ProtocolError("Incoming frame is not valid JSON.");
  }

  if (!isRecord(value)) throw new ProtocolError("Incoming frame must be an object.");
  if (value["protocol"] !== PROTOCOL_NAME || value["version"] !== PROTOCOL_VERSION) {
    throw new ProtocolError("Unsupported protocol or version.");
  }

  if (value["type"] === "message") {
    const frame: WireMessage = {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      type: "message",
      id: requireString(value, "id", 256),
      conversationId: requireString(value, "conversationId", 1024),
      fromPeerId: requireString(value, "fromPeerId", 256),
      toPeerId: requireString(value, "toPeerId", 256),
      text: requireString(value, "text", MAX_TEXT_LENGTH),
      createdAt: requireFiniteNumber(value, "createdAt"),
    };
    if (!frame.text.trim()) throw new ProtocolError("Incoming message is empty.");
    if (frame.conversationId !== conversationIdFor(frame.fromPeerId, frame.toPeerId)) {
      throw new ProtocolError("Incoming message has an invalid conversation ID.");
    }
    return frame;
  }

  if (value["type"] === "ack") {
    return {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      type: "ack",
      messageId: requireString(value, "messageId", 256),
      fromPeerId: requireString(value, "fromPeerId", 256),
      toPeerId: requireString(value, "toPeerId", 256),
      persistedAt: requireFiniteNumber(value, "persistedAt"),
    };
  }

  throw new ProtocolError("Unsupported frame type.");
}

export function encodeSignaling(payload: SignalingPayload): string {
  const text = JSON.stringify(payload);
  if (text.length > MAX_SIGNALING_CHARS) throw new ProtocolError("Pairing data is too large.");
  return text;
}

export function decodeSignaling(
  input: string,
  expectedType: SignalingPayload["type"],
): SignalingPayload {
  if (input.length > MAX_SIGNALING_CHARS) throw new ProtocolError("Pairing data is too large.");

  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new ProtocolError("Pairing data is not valid JSON.");
  }

  if (!isRecord(value)) throw new ProtocolError("Pairing data must be an object.");
  if (value["type"] !== expectedType || value["version"] !== PROTOCOL_VERSION) {
    throw new ProtocolError("This pairing payload is incompatible or used in the wrong step.");
  }
  if (!isRecord(value["peer"]) || !isRecord(value["description"])) {
    throw new ProtocolError("Pairing payload is missing peer or connection information.");
  }

  const peer = value["peer"];
  const description = value["description"];
  const identity: PeerIdentity = {
    id: requireString(peer, "id", 256),
    name: requireString(peer, "name", 80),
  };
  if (description["type"] !== (expectedType === "pairwire-invitation" ? "offer" : "answer")) {
    throw new ProtocolError("Pairing payload has an invalid WebRTC description type.");
  }
  if (typeof description["sdp"] !== "string" || description["sdp"].length > MAX_SIGNALING_CHARS) {
    throw new ProtocolError("Pairing payload has an invalid connection description.");
  }

  return {
    type: expectedType,
    version: PROTOCOL_VERSION,
    peer: identity,
    description: {
      type: description["type"] as RTCSdpType,
      sdp: description["sdp"],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ProtocolError(`Invalid ${key} field.`);
  }
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`Invalid ${key} field.`);
  }
  return value;
}
