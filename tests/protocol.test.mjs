import test from "node:test";
import assert from "node:assert/strict";
import {
  createAcknowledgement,
  createWireMessage,
  decodeFrame,
  decodeSignaling,
  encodeFrame,
  encodeSignaling,
  ProtocolError,
} from "../dist/core/protocol.js";

const alice = "peer-alice";
const bob = "peer-bob";

function sampleMessage(overrides = {}) {
  return createWireMessage({
    id: "message-1",
    fromPeerId: alice,
    toPeerId: bob,
    text: "Hello, Bob.",
    createdAt: 1_800_000_000_000,
    ...overrides,
  });
}

test("message frames survive encode/decode with stable identity and normalized conversation ID", () => {
  const original = sampleMessage();
  const decoded = decodeFrame(encodeFrame(original));
  assert.deepEqual(decoded, original);
  assert.equal(decoded.conversationId, "peer-alice:peer-bob");
});

test("acknowledgements round-trip", () => {
  const original = createAcknowledgement({
    messageId: "message-1",
    fromPeerId: bob,
    toPeerId: alice,
    persistedAt: 1_800_000_000_010,
  });
  assert.deepEqual(decodeFrame(encodeFrame(original)), original);
});

test("empty and whitespace-only messages are rejected", () => {
  assert.throws(() => sampleMessage({ text: "  \n " }), ProtocolError);
  assert.throws(() => sampleMessage({ text: "" }), ProtocolError);
});

test("oversized messages are rejected before transmission", () => {
  assert.throws(() => sampleMessage({ text: "x".repeat(8_001) }), ProtocolError);
});

test("malformed JSON, unknown versions, and unknown frame types are rejected", () => {
  assert.throws(() => decodeFrame("{"), /valid JSON/);
  assert.throws(() => decodeFrame(JSON.stringify({ protocol: "pairwire", version: 2, type: "ack" })), /version/);
  assert.throws(() => decodeFrame(JSON.stringify({ protocol: "pairwire", version: 1, type: "wat" })), /frame type/);
});

test("a message with an inconsistent conversation ID is rejected", () => {
  const frame = { ...sampleMessage(), conversationId: "wrong" };
  assert.throws(() => decodeFrame(JSON.stringify(frame)), /conversation ID/);
});

test("invalid timestamp and missing fields are rejected", () => {
  const good = sampleMessage();
  assert.throws(() => decodeFrame(JSON.stringify({ ...good, createdAt: -1 })), /createdAt/);
  const { text: _text, ...missingText } = good;
  assert.throws(() => decodeFrame(JSON.stringify(missingText)), /text/);
});

test("oversized wire payloads are rejected", () => {
  assert.throws(() => decodeFrame(" ".repeat(64 * 1024 + 1)), /size limit/);
});

test("manual signaling payloads validate role, version, peer, and SDP fields", () => {
  const invitation = {
    type: "pairwire-invitation",
    version: 1,
    peer: { id: alice, name: "Alice" },
    description: { type: "offer", sdp: "v=0\r\nexample" },
  };
  const encoded = encodeSignaling(invitation);
  assert.deepEqual(decodeSignaling(encoded, "pairwire-invitation"), invitation);
  assert.throws(() => decodeSignaling(encoded, "pairwire-response"), /wrong step/);
  assert.throws(() => decodeSignaling(JSON.stringify({ ...invitation, version: 3 }), "pairwire-invitation"), /incompatible/);
  assert.throws(() => decodeSignaling(JSON.stringify({ ...invitation, description: { type: "answer", sdp: "x" } }), "pairwire-invitation"), /description type/);
});
