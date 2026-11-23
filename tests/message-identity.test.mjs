import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSameMessageIdentity } from '../.test-dist/core/message-identity.js';

const original = {
  id: 'message-1',
  conversationId: 'peer-a:peer-b',
  fromPeerId: 'peer-a',
  toPeerId: 'peer-b',
  text: 'Hello',
  createdAt: 1_800_000_000_000,
  direction: 'incoming',
  status: 'delivered',
};

test('retransmitted message identity matches independently of delivery status', () => {
  assert.equal(hasSameMessageIdentity(original, { ...original, status: 'pending' }), true);
});

test('reused message IDs with changed immutable content are conflicts', () => {
  for (const patch of [
    { conversationId: 'other:thread' },
    { fromPeerId: 'peer-c' },
    { toPeerId: 'peer-c' },
    { text: 'Tampered' },
    { createdAt: original.createdAt + 1 },
    { direction: 'outgoing' },
  ]) {
    assert.equal(hasSameMessageIdentity(original, { ...original, ...patch }), false);
  }
});
