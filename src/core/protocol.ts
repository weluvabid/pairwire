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
  const id = validateIdentifier(input.id, "id");
  const fromPeerId = validateIdentifier(input.fromPeerId, "fromPeerId");
  const toPeerId = validateIdentifier(input.toPeerId, "toPeerId");
  if (fromPeerId === toPeerId) throw new ProtocolError("A message cannot be sent to the same device.");
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: "message",
    id,
    conversationId: conversationIdFor(fromPeerId, toPeerId),
    fromPeerId,
    toPeerId,
    text,
    createdAt: requireTimestamp(input.createdAt, "createdAt"),
  };
}

export function createAcknowledgement(input: {
  messageId: string;
  fromPeerId: string;
  toPeerId: string;
  persistedAt: number;
}): WireAcknowledgement {
  const fromPeerId = validateIdentifier(input.fromPeerId, "fromPeerId");
  const toPeerId = validateIdentifier(input.toPeerId, "toPeerId");
  if (fromPeerId === toPeerId) throw new ProtocolError("An acknowledgement cannot target the same device.");
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: "ack",
    messageId: validateIdentifier(input.messageId, "messageId"),
    fromPeerId,
    toPeerId,
    persistedAt: requireTimestamp(input.persistedAt, "persistedAt"),
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
      id: requireIdentifier(value, "id"),
      conversationId: requireString(value, "conversationId", 513),
      fromPeerId: requirePeerId(value, "fromPeerId"),
      toPeerId: requirePeerId(value, "toPeerId"),
      text: requireString(value, "text", MAX_TEXT_LENGTH),
      createdAt: requireTimestamp(requireFiniteNumber(value, "createdAt"), "createdAt"),
    };
    if (!frame.text.trim()) throw new ProtocolError("Incoming message is empty.");
    if (frame.fromPeerId === frame.toPeerId) throw new ProtocolError("A message cannot be sent to the same device.");
    if (frame.conversationId !== conversationIdFor(frame.fromPeerId, frame.toPeerId)) {
      throw new ProtocolError("Incoming message has an invalid conversation ID.");
    }
    return frame;
  }

  if (value["type"] === "ack") {
    const fromPeerId = requirePeerId(value, "fromPeerId");
    const toPeerId = requirePeerId(value, "toPeerId");
    if (fromPeerId === toPeerId) throw new ProtocolError("An acknowledgement cannot target the same device.");
    return {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      type: "ack",
      messageId: requireIdentifier(value, "messageId"),
      fromPeerId,
      toPeerId,
      persistedAt: requireTimestamp(requireFiniteNumber(value, "persistedAt"), "persistedAt"),
    };
  }

  throw new ProtocolError("Unsupported frame type.");
}

export function encodeSignaling(payload: SignalingPayload): string {
  const text = JSON.stringify(payload);
  if (text.length > MAX_SIGNALING_CHARS) throw new ProtocolError("Pairing data is too large.");
  return text;
}

export type DecodedSignaling = SignalingPayload;

/** Decode either supported signaling payload without trusting its declared type. */
export function decodeAnySignaling(input: string): DecodedSignaling {
  if (input.length > MAX_SIGNALING_CHARS) throw new ProtocolError("Pairing data is too large.");
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new ProtocolError("This doesn't look like a Pairwire invitation or response.");
  }
  if (!isRecord(value)) {
    throw new ProtocolError("This doesn't look like a Pairwire invitation or response.");
  }
  if (value["type"] === "pairwire-invitation") return decodeSignaling(input, "pairwire-invitation");
  if (value["type"] === "pairwire-response") return decodeSignaling(input, "pairwire-response");
  throw new ProtocolError("This doesn't look like a Pairwire invitation or response.");
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
    id: requirePeerId(peer, "id"),
    name: normalizeRemoteName(requireString(peer, "name", 48)),
  };
  if (identity.name.trim() !== identity.name || /[\u0000-\u001f\u007f]/.test(identity.name)) {
    throw new ProtocolError("Invalid peer display name.");
  }
  if (description["type"] !== (expectedType === "pairwire-invitation" ? "offer" : "answer")) {
    throw new ProtocolError("Pairing payload has an invalid WebRTC description type.");
  }
  if (typeof description["sdp"] !== "string" || !description["sdp"].trim() || description["sdp"].length > MAX_SIGNALING_CHARS) {
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

function requireTimestamp(value: number, key: string): number {
  if (!Number.isSafeInteger(value) || value > 8_640_000_000_000_000) {
    throw new ProtocolError(`Invalid ${key} field.`);
  }
  return value;
}

function requireIdentifier(record: Record<string, unknown>, key: string): string {
  return validateIdentifier(requireString(record, key, 256), key);
}

function validateIdentifier(value: string, key: string): string {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(value)) throw new ProtocolError(`Invalid ${key} field.`);
  return value;
}

function requirePeerId(record: Record<string, unknown>, key: string): string {
  return requireIdentifier(record, key);
}

function normalizeRemoteName(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ProtocolError("Invalid peer display name.");
  }
  return normalized;
}
