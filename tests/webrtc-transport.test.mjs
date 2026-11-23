import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRtcTransport } from '../.test-dist/transport/webrtc.js';
import { decodeSignaling } from '../.test-dist/core/protocol.js';

class FakeDataChannel extends EventTarget {
  constructor() {
    super();
  }
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'connecting';
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  sent = [];
  close() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('channel is not open');
    this.sent.push(data);
    this.bufferedAmount += new TextEncoder().encode(data).byteLength;
  }
  drain(amount = 0) {
    this.bufferedAmount = amount;
    this.dispatchEvent(new Event('bufferedamountlow'));
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeerConnection {
  static instances = [];
  connectionState = 'new';
  iceConnectionState = 'new';
  iceGatheringState = 'complete';
  localDescription = null;
  remoteDescription = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  ondatachannel = null;
  channels = [];

  constructor(_configuration) {
    FakePeerConnection.instances.push(this);
  }
  createDataChannel(_label, _options) {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\nmock-offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\nmock-answer' };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.connectionState = 'closed';
  }
}

function callbacks() {
  return {
    states: [],
    data: [],
    peers: [],
    errors: [],
    onStateChange(state) {
      this.states.push(state);
    },
    onData(data) {
      this.data.push(data);
    },
    onRemotePeer(peer) {
      this.peers.push(peer);
    },
    onError(error) {
      this.errors.push(error);
    },
  };
}

test('manual signaling completes the offer/answer exchange without a signaling service', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const hostCallbacks = callbacks();
  const host = new WebRtcTransport(hostCallbacks);
  const invitationText = await host.createInvitation({ id: 'peer-host', name: 'Host' });
  const invitation = decodeSignaling(invitationText, 'pairwire-invitation');
  assert.equal(invitation.peer.id, 'peer-host');

  const guestCallbacks = callbacks();
  const guest = new WebRtcTransport(guestCallbacks);
  const responseText = await guest.acceptInvitation(invitationText, {
    id: 'peer-guest',
    name: 'Guest',
  });
  const response = decodeSignaling(responseText, 'pairwire-response');
  assert.equal(response.peer.id, 'peer-guest');
  assert.deepEqual(guestCallbacks.peers, [{ id: 'peer-host', name: 'Host' }]);

  await host.completePairing(responseText, 'peer-host');
  assert.deepEqual(hostCallbacks.peers, [{ id: 'peer-guest', name: 'Guest' }]);
  assert.equal(FakePeerConnection.instances[0].remoteDescription.type, 'answer');
  assert.equal(FakePeerConnection.instances[1].remoteDescription.type, 'offer');
});

test('data channel rejects early sends and surfaces open, data, and close events', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const observer = callbacks();
  const transport = new WebRtcTransport(observer);
  await transport.createInvitation({ id: 'peer-a', name: 'A' });
  const connection = FakePeerConnection.instances[0];
  const channel = connection.channels[0];
  await assert.rejects(transport.send('before-open'), /not ready/);

  channel.open();
  await transport.send('hello');
  assert.deepEqual(channel.sent, ['hello']);
  assert.equal(transport.connectionState, 'connected');

  channel.onmessage?.({ data: 'incoming' });
  assert.deepEqual(observer.data, ['incoming']);
  channel.onclose?.();
  assert.equal(transport.connectionState, 'disconnected');
  transport.close();
  assert.equal(transport.connectionState, 'closed');
});

test('reconnect signaling rejects a different peer identity without mutating the active conversation', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const host = new WebRtcTransport(callbacks());
  const invitation = await host.createInvitation({ id: 'known-peer', name: 'Known' });
  const guest = new WebRtcTransport(callbacks());
  const response = await guest.acceptInvitation(invitation, {
    id: 'different-peer',
    name: 'Different',
  });

  await assert.rejects(
    host.completePairing(response, 'known-peer', 'expected-peer'),
    /different peer/i,
  );
  assert.equal(host.connectedPeer, null);
  assert.equal(FakePeerConnection.instances[0].remoteDescription, null);
});

test('reconnect invitation can be constrained to the previously known peer', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const host = new WebRtcTransport(callbacks());
  const invitation = await host.createInvitation({ id: 'known-peer', name: 'Known' });
  const guest = new WebRtcTransport(callbacks());
  await guest.createInvitation({ id: 'guest', name: 'Guest' });

  await assert.rejects(
    guest.acceptInvitation(invitation, { id: 'guest', name: 'Guest' }, 'different-peer'),
    /different peer/i,
  );
  assert.equal(
    guest.connectionState,
    'connecting',
    'a mismatched invitation must not close the existing transport',
  );

  const response = await guest.acceptInvitation(
    invitation,
    { id: 'guest', name: 'Guest' },
    'known-peer',
  );
  assert.equal(decodeSignaling(response, 'pairwire-response').peer.id, 'guest');
});

test('ICE gathering completion between listener registration and state recheck is observed', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  class GatheringRaceConnection extends FakePeerConnection {
    iceGatheringState = 'gathering';
    addEventListener(type, listener) {
      if (type === 'icegatheringstatechange') {
        this.iceGatheringState = 'complete';
        listener();
      }
    }
  }
  globalThis.RTCPeerConnection = GatheringRaceConnection;
  GatheringRaceConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const transport = new WebRtcTransport(callbacks());
  const invitation = await transport.createInvitation({ id: 'peer-race', name: 'Race' });
  assert.equal(decodeSignaling(invitation, 'pairwire-invitation').peer.id, 'peer-race');
});

test('send queue applies backpressure and resumes below the low-water mark', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const transport = new WebRtcTransport(callbacks());
  await transport.createInvitation({ id: 'peer-buffer', name: 'Buffer' });
  const channel = FakePeerConnection.instances[0].channels[0];
  channel.open();
  channel.bufferedAmount = 256 * 1024;

  const first = transport.send('first');
  const second = transport.send('second');
  await Promise.resolve();
  assert.deepEqual(channel.sent, [], 'frames wait while the buffer is above the high-water mark');
  assert.equal(channel.bufferedAmountLowThreshold, 64 * 1024);

  channel.drain(32 * 1024);
  await Promise.all([first, second]);
  assert.deepEqual(channel.sent, ['first', 'second']);

  channel.bufferedAmount = 256 * 1024;
  const interrupted = transport.send('interrupted');
  await Promise.resolve();
  transport.close();
  await assert.rejects(interrupted, /closed while waiting/i);
});

test('closing a transport cancels pending ICE gathering', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  class GatheringConnection extends FakePeerConnection {
    iceGatheringState = 'gathering';
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
    }
  }
  globalThis.RTCPeerConnection = GatheringConnection;
  GatheringConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const transport = new WebRtcTransport(callbacks());
  const invitation = transport.createInvitation({ id: 'peer-cancel', name: 'Cancel' });
  await Promise.resolve();
  await Promise.resolve();
  transport.close();
  await assert.rejects(invitation, /cancelled/i);
  assert.equal(transport.connectionState, 'closed');
});

test('outgoing producer queue has a fixed capacity', async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => {
    globalThis.RTCPeerConnection = previous;
  });

  const transport = new WebRtcTransport(callbacks());
  await transport.createInvitation({ id: 'peer-capacity', name: 'Capacity' });
  const channel = FakePeerConnection.instances[0].channels[0];
  channel.open();
  channel.bufferedAmount = 256 * 1024;

  const queued = Array.from({ length: 256 }, (_, index) => transport.send(`message-${index}`));
  await assert.rejects(transport.send('overflow'), /queue is full/i);
  transport.close();
  const results = await Promise.allSettled(queued);
  assert.equal(results.length, 256);
  assert.ok(results.every((result) => result.status === 'rejected'));
});
