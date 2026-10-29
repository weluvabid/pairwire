import { decodeSignaling, encodeSignaling, ProtocolError } from "../core/protocol.js";
import type { ConnectionState, PeerIdentity, SignalingPayload } from "../core/types.js";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const GATHERING_TIMEOUT_MS = 20_000;

export interface TransportCallbacks {
  onStateChange(state: ConnectionState): void;
  onData(data: string): void;
  onRemotePeer(peer: PeerIdentity): void;
  onError(error: Error): void;
}

export class WebRtcTransport {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private role: "initiator" | "responder" | null = null;
  private remotePeer: PeerIdentity | null = null;
  private state: ConnectionState = "new";
  private readonly callbacks: TransportCallbacks;

  constructor(callbacks: TransportCallbacks) {
    this.callbacks = callbacks;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get connectedPeer(): PeerIdentity | null {
    return this.remotePeer;
  }

  async createInvitation(localPeer: PeerIdentity): Promise<string> {
    this.close(false);
    this.role = "initiator";
    this.setState("connecting");
    const connection = this.createConnection();
    this.channel = connection.createDataChannel("pairwire", { ordered: true });
    this.bindChannel(this.channel);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);
    const description = connection.localDescription;
    if (!description?.sdp) throw new Error("The browser did not produce a connection description.");

    const payload: SignalingPayload = {
      type: "pairwire-invitation",
      version: 1,
      peer: localPeer,
      description: { type: description.type, sdp: description.sdp },
    };
    return encodeSignaling(payload);
  }

  async acceptInvitation(input: string, localPeer: PeerIdentity): Promise<string> {
    this.close(false);
    const invitation = decodeSignaling(input, "pairwire-invitation");
    if (invitation.peer.id === localPeer.id) throw new ProtocolError("You cannot pair with yourself.");
    this.role = "responder";
    this.remotePeer = invitation.peer;
    this.callbacks.onRemotePeer(invitation.peer);
    this.setState("connecting");

    const connection = this.createConnection();
    await connection.setRemoteDescription(invitation.description);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await waitForIceGathering(connection);
    const description = connection.localDescription;
    if (!description?.sdp) throw new Error("The browser did not produce a connection response.");

    const payload: SignalingPayload = {
      type: "pairwire-response",
      version: 1,
      peer: localPeer,
      description: { type: description.type, sdp: description.sdp },
    };
    return encodeSignaling(payload);
  }

  async completePairing(input: string, localPeerId: string): Promise<void> {
    if (this.role !== "initiator" || !this.connection) {
      throw new Error("Create an invitation before importing a response.");
    }
    const response = decodeSignaling(input, "pairwire-response");
    if (response.peer.id === localPeerId) throw new ProtocolError("You cannot pair with yourself.");
    this.remotePeer = response.peer;
    this.callbacks.onRemotePeer(response.peer);
    await this.connection.setRemoteDescription(response.description);
  }

  send(data: string): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new Error("The peer connection is not ready to send messages.");
    }
    this.channel.send(data);
  }

  close(emitState = true): void {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    this.role = null;
    this.remotePeer = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // The channel can already be closed by the browser.
      }
    }
    if (connection) {
      connection.onconnectionstatechange = null;
      connection.oniceconnectionstatechange = null;
      connection.ondatachannel = null;
      try {
        connection.close();
      } catch {
        // The connection can already be closed by the browser.
      }
    }
    this.state = "closed";
    if (emitState) this.callbacks.onStateChange("closed");
  }

  private createConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connection = connection;
    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === "connected") {
        if (this.channel?.readyState === "open") this.setState("connected");
      } else if (state === "connecting" || state === "new") this.setState("connecting");
      else if (state === "disconnected") this.setState("disconnected");
      else if (state === "failed") this.setState("failed");
      else if (state === "closed") this.setState("closed");
    };
    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === "failed") this.setState("failed");
    };
    connection.ondatachannel = (event) => {
      if (this.role !== "responder") {
        event.channel.close();
        return;
      }
      if (this.channel && this.channel !== event.channel) {
        event.channel.close();
        return;
      }
      this.channel = event.channel;
      this.bindChannel(event.channel);
    };
    return connection;
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.onopen = () => this.setState("connected");
    channel.onclose = () => {
      if (this.state !== "closed" && this.state !== "failed") this.setState("disconnected");
    };
    channel.onerror = () => this.callbacks.onError(new Error("The WebRTC data channel reported an error."));
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") {
        this.callbacks.onError(new Error("Received a message in an unsupported data format."));
        return;
      }
      this.callbacks.onData(event.data);
    };
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange(state);
  }
}

function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", handleStateChange);
      connection.removeEventListener("icecandidateerror", handleCandidateError);
    };
    const handleStateChange = () => {
      if (connection.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const handleCandidateError = () => {
      // Individual STUN errors can be non-fatal; gathering completion decides viability.
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Gathering connection candidates timed out. Check your network and retry."));
    }, GATHERING_TIMEOUT_MS);
    connection.addEventListener("icegatheringstatechange", handleStateChange);
    connection.addEventListener("icecandidateerror", handleCandidateError);
  });
}
