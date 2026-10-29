import test from "node:test";
import assert from "node:assert/strict";
import { WebRtcTransport } from "../dist/transport/webrtc.js";
import { decodeSignaling } from "../dist/core/protocol.js";

class FakeDataChannel {
  readyState = "connecting";
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  sent = [];
  close() { this.readyState = "closed"; }
  send(data) {
    if (this.readyState !== "open") throw new Error("channel is not open");
    this.sent.push(data);
  }
  open() { this.readyState = "open"; this.onopen?.(); }
}

class FakePeerConnection {
  static instances = [];
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "complete";
  localDescription = null;
  remoteDescription = null;
  onconnectionstatechange = null;
  oniceconnectionstatechange = null;
  ondatachannel = null;
  channels = [];

  constructor(_configuration) { FakePeerConnection.instances.push(this); }
  createDataChannel(_label, _options) {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel;
  }
  async createOffer() { return { type: "offer", sdp: "v=0\r\nmock-offer" }; }
  async createAnswer() { return { type: "answer", sdp: "v=0\r\nmock-answer" }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = "closed"; }
}

function callbacks() {
  return { states: [], data: [], peers: [], errors: [], onStateChange(state) { this.states.push(state); }, onData(data) { this.data.push(data); }, onRemotePeer(peer) { this.peers.push(peer); }, onError(error) { this.errors.push(error); } };
}

test("manual signaling completes the offer/answer exchange without a signaling service", async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => { globalThis.RTCPeerConnection = previous; });

  const hostCallbacks = callbacks();
  const host = new WebRtcTransport(hostCallbacks);
  const invitationText = await host.createInvitation({ id: "peer-host", name: "Host" });
  const invitation = decodeSignaling(invitationText, "pairwire-invitation");
  assert.equal(invitation.peer.id, "peer-host");

  const guestCallbacks = callbacks();
  const guest = new WebRtcTransport(guestCallbacks);
  const responseText = await guest.acceptInvitation(invitationText, { id: "peer-guest", name: "Guest" });
  const response = decodeSignaling(responseText, "pairwire-response");
  assert.equal(response.peer.id, "peer-guest");
  assert.deepEqual(guestCallbacks.peers, [{ id: "peer-host", name: "Host" }]);

  await host.completePairing(responseText, "peer-host");
  assert.deepEqual(hostCallbacks.peers, [{ id: "peer-guest", name: "Guest" }]);
  assert.equal(FakePeerConnection.instances[0].remoteDescription.type, "answer");
  assert.equal(FakePeerConnection.instances[1].remoteDescription.type, "offer");
});

test("data channel rejects early sends and surfaces open, data, and close events", async (context) => {
  const previous = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakePeerConnection;
  FakePeerConnection.instances = [];
  context.after(() => { globalThis.RTCPeerConnection = previous; });

  const observer = callbacks();
  const transport = new WebRtcTransport(observer);
  await transport.createInvitation({ id: "peer-a", name: "A" });
  const connection = FakePeerConnection.instances[0];
  const channel = connection.channels[0];
  assert.throws(() => transport.send("before-open"), /not ready/);

  channel.open();
  transport.send("hello");
  assert.deepEqual(channel.sent, ["hello"]);
  assert.equal(transport.connectionState, "connected");

  channel.onmessage?.({ data: "incoming" });
  assert.deepEqual(observer.data, ["incoming"]);
  channel.onclose?.();
  assert.equal(transport.connectionState, "disconnected");
  transport.close();
  assert.equal(transport.connectionState, "closed");
});
