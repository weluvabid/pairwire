import { decodeSignaling, encodeSignaling, ProtocolError } from '../core/protocol.js';
import type { ConnectionState, PeerIdentity, SignalingPayload } from '../core/types.js';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const GATHERING_TIMEOUT_MS = 20_000;
const SEND_BUFFER_HIGH_WATER_BYTES = 256 * 1024;
const SEND_BUFFER_LOW_WATER_BYTES = 64 * 1024;
const SEND_DRAIN_TIMEOUT_MS = 15_000;
const MAX_QUEUED_SENDS = 256;

export interface TransportCallbacks {
  onStateChange(state: ConnectionState): void;
  onData(data: string): void;
  onRemotePeer(peer: PeerIdentity): void;
  onError(error: Error): void;
}

export class WebRtcTransport {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private role: 'initiator' | 'responder' | null = null;
  private remotePeer: PeerIdentity | null = null;
  private state: ConnectionState = 'new';
  private readonly callbacks: TransportCallbacks;
  private connectionAbort: AbortController | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private queuedSends = 0;

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
    this.role = 'initiator';
    this.setState('connecting');
    const connection = this.createConnection();
    const signal = this.connectionAbort?.signal;

    if (!signal) {
      throw new Error('Connection setup was cancelled.');
    }

    this.channel = connection.createDataChannel('pairwire', { ordered: true });
    this.bindChannel(this.channel);

    const offer = await connection.createOffer();
    this.assertCurrentConnection(connection, signal);
    await connection.setLocalDescription(offer);
    this.assertCurrentConnection(connection, signal);
    await waitForIceGathering(connection, signal);
    this.assertCurrentConnection(connection, signal);
    const description = connection.localDescription;
    if (!description?.sdp) throw new Error('The browser did not produce a connection description.');

    const payload: SignalingPayload = {
      type: 'pairwire-invitation',
      version: 1,
      peer: localPeer,
      description: { type: description.type, sdp: description.sdp },
    };
    return encodeSignaling(payload);
  }

  async acceptInvitation(
    input: string,
    localPeer: PeerIdentity,
    expectedPeerId?: string,
  ): Promise<string> {
    const invitation = decodeSignaling(input, 'pairwire-invitation');
    if (invitation.peer.id === localPeer.id)
      throw new ProtocolError('You cannot pair with yourself.');
    if (expectedPeerId && invitation.peer.id !== expectedPeerId) {
      throw new ProtocolError(
        'This invitation belongs to a different peer. Your existing conversation was not changed.',
      );
    }
    this.close(false);
    this.role = 'responder';
    this.setState('connecting');

    const connection = this.createConnection();
    const signal = this.connectionAbort?.signal;

    if (!signal) {
      throw new Error('Connection setup was cancelled.');
    }

    await connection.setRemoteDescription(invitation.description);
    this.assertCurrentConnection(connection, signal);
    const answer = await connection.createAnswer();
    this.assertCurrentConnection(connection, signal);
    await connection.setLocalDescription(answer);
    this.assertCurrentConnection(connection, signal);
    await waitForIceGathering(connection, signal);
    this.assertCurrentConnection(connection, signal);
    const description = connection.localDescription;
    if (!description?.sdp) throw new Error('The browser did not produce a connection response.');

    this.remotePeer = invitation.peer;
    this.callbacks.onRemotePeer(invitation.peer);
    const payload: SignalingPayload = {
      type: 'pairwire-response',
      version: 1,
      peer: localPeer,
      description: { type: description.type, sdp: description.sdp },
    };
    return encodeSignaling(payload);
  }

  async completePairing(
    input: string,
    localPeerId: string,
    expectedPeerId?: string,
  ): Promise<void> {
    if (this.role !== 'initiator' || !this.connection) {
      throw new Error('Create an invitation before importing a response.');
    }
    const response = decodeSignaling(input, 'pairwire-response');
    if (response.peer.id === localPeerId) throw new ProtocolError('You cannot pair with yourself.');
    if (expectedPeerId && response.peer.id !== expectedPeerId) {
      throw new ProtocolError(
        'That response belongs to a different peer. Your existing conversation was not changed.',
      );
    }
    const connection = this.connection;
    const signal = this.connectionAbort?.signal;
    if (!signal) throw new Error('The pending connection was closed.');
    await connection.setRemoteDescription(response.description);
    this.assertCurrentConnection(connection, signal);
    this.remotePeer = response.peer;
    this.callbacks.onRemotePeer(response.peer);
  }

  send(data: string): Promise<void> {
    // Serialize all producers through one bounded queue. Without this,
    // concurrent callers can all observe a low bufferedAmount and overshoot it.
    if (this.queuedSends >= MAX_QUEUED_SENDS) {
      return Promise.reject(
        new Error('The outgoing message queue is full. Retry after it drains.'),
      );
    }
    this.queuedSends += 1;
    const operation = this.sendQueue.then(() => this.sendWhenReady(data));
    const settled = operation.finally(() => {
      this.queuedSends -= 1;
    });
    this.sendQueue = settled.catch(() => undefined);
    return settled;
  }

  close(emitState = true): void {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
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
    this.state = 'closed';
    if (emitState) this.callbacks.onStateChange('closed');
  }

  private assertCurrentConnection(connection: RTCPeerConnection, signal: AbortSignal): void {
    if (signal.aborted || this.connection !== connection) {
      throw new Error('Connection setup was cancelled.');
    }
  }

  private async sendWhenReady(data: string): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') {
      throw new Error('The peer connection is not ready to send messages.');
    }
    const bytes = new TextEncoder().encode(data).byteLength;
    if (bytes > SEND_BUFFER_HIGH_WATER_BYTES) {
      throw new Error('The outgoing frame exceeds the transport buffer limit.');
    }
    if (channel.bufferedAmount + bytes > SEND_BUFFER_HIGH_WATER_BYTES) {
      await waitForBufferedAmountLow(channel);
    }
    if (this.channel !== channel || channel.readyState !== 'open') {
      throw new Error('The peer connection closed before the message could be sent.');
    }
    channel.send(data);
  }

  private createConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connectionAbort = new AbortController();
    this.connection = connection;
    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'connected') {
        if (this.channel?.readyState === 'open') this.setState('connected');
      } else if (state === 'connecting' || state === 'new') this.setState('connecting');
      else if (state === 'disconnected') this.setState('disconnected');
      else if (state === 'failed') this.setState('failed');
      else if (state === 'closed') this.setState('closed');
    };
    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === 'failed') this.setState('failed');
    };
    connection.ondatachannel = (event) => {
      if (this.role !== 'responder') {
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
    channel.onopen = () => this.setState('connected');
    channel.onclose = () => {
      if (this.state !== 'closed' && this.state !== 'failed') this.setState('disconnected');
    };
    channel.onerror = () =>
      this.callbacks.onError(new Error('The WebRTC data channel reported an error.'));
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') {
        this.callbacks.onError(new Error('Received a message in an unsupported data format.'));
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

function waitForIceGathering(connection: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Connection setup was cancelled.'));
  if (connection.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () =>
        finish(
          new Error('Gathering connection candidates timed out. Check your network and retry.'),
        ),
      GATHERING_TIMEOUT_MS,
    );

    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', handleStateChange);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleStateChange = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const handleAbort = () => finish(new Error('Connection setup was cancelled.'));

    connection.addEventListener('icegatheringstatechange', handleStateChange);
    signal.addEventListener('abort', handleAbort, { once: true });
    // Recheck after subscribing so completion cannot fall between the initial
    // state check and listener registration.
    handleStateChange();
  });
}

function waitForBufferedAmountLow(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState !== 'open') {
    return Promise.reject(new Error('The peer connection is not ready to send messages.'));
  }
  channel.bufferedAmountLowThreshold = SEND_BUFFER_LOW_WATER_BYTES;
  if (channel.bufferedAmount <= SEND_BUFFER_LOW_WATER_BYTES) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error('The outgoing message queue did not drain in time.')),
      SEND_DRAIN_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener('bufferedamountlow', handleLow);
      channel.removeEventListener('close', handleClose);
      channel.removeEventListener('error', handleError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleLow = () => {
      if (channel.bufferedAmount <= SEND_BUFFER_LOW_WATER_BYTES) finish();
    };
    const handleClose = () =>
      finish(new Error('The peer connection closed while waiting for the send buffer.'));
    const handleError = () =>
      finish(new Error('The peer connection failed while waiting for the send buffer.'));

    channel.addEventListener('bufferedamountlow', handleLow);
    channel.addEventListener('close', handleClose, { once: true });
    channel.addEventListener('error', handleError, { once: true });
    // Recheck after subscribing to avoid missing a drain between the initial
    // amount check and listener registration.
    handleLow();
  });
}
