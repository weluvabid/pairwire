import test from 'node:test';
import assert from 'node:assert/strict';
import { isoTime, prettyTime, countPendingByPeer } from '../.test-dist/utils/formatting.js';

test('message time formatting is safe for corrupt legacy timestamps', () => {
  assert.equal(isoTime(1e300), undefined);
  assert.equal(prettyTime(1e300), 'Unknown time');
  assert.equal(typeof isoTime(1_800_000_000_000), 'string');
});

test('pending counts are scoped to the target peer', () => {
  const messages = [{ toPeerId: 'peer-a' }, { toPeerId: 'peer-a' }, { toPeerId: 'peer-b' }];
  const counts = countPendingByPeer(messages);
  assert.equal(counts.get('peer-a'), 2);
  assert.equal(counts.get('peer-b'), 1);
  assert.equal(counts.get('peer-c') ?? 0, 0);
});
