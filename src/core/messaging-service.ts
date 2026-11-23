import { createAcknowledgement, createWireMessage, decodeFrame, decodeSignaling, encodeFrame, ProtocolError } from "./protocol.js";
import type { ChatMessage, PeerIdentity, WireMessage } from "./types.js";
import { conversationIdFor, MAX_TEXT_LENGTH } from "./types.js";
import { PairwireStore } from "../storage/indexed-db.js";
import { WebRtcTransport } from "../transport/webrtc.js";

const MAX_QUEUED_INCOMING_FRAMES = 256;

export interface MessagingCallbacks {
  onChange(): void;
  onNotice(message: string, kind?: "info" | "error"): void;
}

export class MessagingService {
  private readonly store: PairwireStore;
  private readonly callbacks: MessagingCallbacks;
  private transport: WebRtcTransport | null = null;
  private localPeer: PeerIdentity | null = null;
  private activePeer: PeerIdentity | null = null;
  private processing = Promise.resolve();
  private readonly pendingFramesByTransport = new Map<WebRtcTransport, number>();
  private readonly flushPromises = new Map<string, { transport: WebRtcTransport; promise: Promise<void> }>();
  private readonly connectionWork = new WeakMap<WebRtcTransport, Promise<void>>();
  private readonly announcedConnections = new WeakSet<WebRtcTransport>();

  constructor(store: PairwireStore, callbacks: MessagingCallbacks) {
    this.store = store;
    this.callbacks = callbacks;
  }

  get connectionState(): string {
    return this.transport?.connectionState ?? "new";
  }

  get connectedPeer(): PeerIdentity | null {
    return this.activePeer;
  }

  async initialize(): Promise<PeerIdentity> {
    const id = await this.store.getOrCreateDeviceId();
    const name = await this.store.getDisplayName();
    await this.store.recoverOutboxAfterRestart();
    this.localPeer = { id, name };
    this.callbacks.onChange();
    return this.localPeer;
  }

  async getStoredDisplayName(): Promise<string | null> {
    return this.store.getStoredDisplayName();
  }

  async updateDisplayName(name: string): Promise<PeerIdentity> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 48 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new Error("Display names must contain 1–48 visible characters.");
    }
    await this.store.setDisplayName(normalized);
    if (!this.localPeer) return this.initialize();
    this.localPeer = { ...this.localPeer, name: await this.store.getDisplayName() };
    return this.localPeer;
  }

  async createInvitation(): Promise<string> {
    const local = await this.ensureLocalPeer();
    const transport = this.createTransport();
    try {
      return await transport.createInvitation(local);
    } catch (error) {
      if (this.transport === transport) this.closeConnection();
      throw error;
    }
  }

  async acceptInvitation(input: string, expectedPeerId?: string): Promise<string> {
    const local = await this.ensureLocalPeer();
    const invitation = decodeSignaling(input, "pairwire-invitation");
    if (invitation.peer.id === local.id) throw new ProtocolError("You cannot pair with yourself.");
    if (expectedPeerId && invitation.peer.id !== expectedPeerId) {
      throw new ProtocolError("This invitation belongs to a different peer. Your existing conversation was not changed.");
    }
    const transport = this.createTransport();
    try {
      return await transport.acceptInvitation(input, local, expectedPeerId);
    } catch (error) {
      if (this.transport === transport) this.closeConnection();
      throw error;
    }
  }

  async completePairing(input: string, expectedPeerId?: string): Promise<void> {
    const local = await this.ensureLocalPeer();
    const transport = this.transport;
    if (!transport) throw new Error("Create an invitation before importing a response.");

    // Validate user-supplied signaling before entering the transport mutation path.
    // A malformed or mismatched clipboard value must not destroy a valid pending offer.
    const response = decodeSignaling(input, "pairwire-response");
    if (response.peer.id === local.id) throw new ProtocolError("You cannot pair with yourself.");
    if (expectedPeerId && response.peer.id !== expectedPeerId) {
      throw new ProtocolError("That response belongs to a different peer. Your existing conversation was not changed.");
    }

    try {
      await transport.completePairing(input, local.id, expectedPeerId);
      this.callbacks.onChange();
    } catch (error) {
      if (this.transport === transport) this.closeConnection();
      throw error;
    }
  }

  async sendMessage(text: string): Promise<ChatMessage> {
    const local = await this.ensureLocalPeer();
    const peer = this.activePeer;
    if (!peer || this.connectionState !== "connected") {
      throw new Error("Connect to a peer before sending a message.");
    }
    const normalized = text.trim();
    if (!normalized) throw new Error("Write a message first.");
    if (normalized.length > MAX_TEXT_LENGTH) {
      throw new Error(`Messages must be ${MAX_TEXT_LENGTH.toLocaleString()} characters or fewer.`);
    }

    const createdAt = Date.now();
    const wire = createWireMessage({
      id: crypto.randomUUID(),
      fromPeerId: local.id,
      toPeerId: peer.id,
      text: normalized,
      createdAt,
    });
    const message: ChatMessage = { ...wire, direction: "outgoing", status: "pending" };
    await this.store.createOutgoing(message);
    this.callbacks.onChange();
    await this.transmit(message);
    return message;
  }

  async retryMessage(id: string): Promise<void> {
    if (this.connectionState !== "connected") throw new Error("Reconnect before retrying this message.");
    const updated = await this.store.retryMessage(id);
    if (updated) await this.transmit(updated);
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    return this.store.getMessages(conversationId);
  }

  async getPeers() {
    return this.store.getPeers();
  }

  async getConversations() {
    return this.store.getConversations();
  }

  async getOutbox(): Promise<ChatMessage[]> {
    return this.store.getOutbox();
  }

  async deleteConversation(peerId: string, conversationId: string): Promise<void> {
    if (this.activePeer?.id === peerId) this.closeConnection();
    await this.processing;
    await this.store.deleteConversation(peerId, conversationId);
    this.callbacks.onChange();
  }

  closeConnection(): void {
    this.transport?.close();
    this.transport = null;
    this.activePeer = null;
    this.callbacks.onChange();
  }

  private createTransport(): WebRtcTransport {
    this.transport?.close(false);
    this.activePeer = null;
    let transport!: WebRtcTransport;
    transport = new WebRtcTransport({
      onStateChange: (state) => {
        if (state === "connected") {
          void this.onConnected().catch((error: unknown) => this.callbacks.onNotice(errorMessage(error), "error"));
        }
        if (state === "failed" || state === "disconnected") {
          this.callbacks.onNotice("Connection interrupted. Pending messages stay on this device.", "info");
        }
        this.callbacks.onChange();
      },
      onData: (data) => {
        if (this.transport !== transport) return;
        const pending = this.pendingFramesByTransport.get(transport) ?? 0;
        if (pending >= MAX_QUEUED_INCOMING_FRAMES) {
          this.callbacks.onNotice("Incoming message backlog exceeded the safety limit. Reconnect to retry unacknowledged messages.", "error");
          this.closeConnection();
          return;
        }
        this.pendingFramesByTransport.set(transport, pending + 1);
        this.processing = this.processing
          .then(() => this.handleFrame(data, transport))
          .catch((error: unknown) => this.callbacks.onNotice(errorMessage(error), "error"))
          .finally(() => {
            const remaining = (this.pendingFramesByTransport.get(transport) ?? 1) - 1;
            if (remaining > 0) this.pendingFramesByTransport.set(transport, remaining);
            else this.pendingFramesByTransport.delete(transport);
          });
      },
      onRemotePeer: (peer) => {
        if (this.transport !== transport) return;
        this.activePeer = peer;
        this.callbacks.onChange();
        if (transport.connectionState === "connected") {
          void this.onConnected().catch((error: unknown) => this.callbacks.onNotice(errorMessage(error), "error"));
        }
      },
      onError: (error) => this.callbacks.onNotice(error.message, "error"),
    });
    this.transport = transport;
    return transport;
  }

  private async onConnected(): Promise<void> {
    const transport = this.transport;
    const peer = this.activePeer;
    if (!transport || !peer || transport.connectionState !== "connected") return;

    // Both the data-channel state event and remote-identity callback can observe
    // the same successful handshake. Share one operation per transport so peer
    // persistence, the success notice, and outbox recovery happen exactly once.
    const existing = this.connectionWork.get(transport);
    if (existing) return existing;

    const work = (async () => {
      if (this.transport !== transport || this.activePeer?.id !== peer.id || transport.connectionState !== "connected") return;
      await this.persistPeer(peer);
      if (this.transport !== transport || this.activePeer?.id !== peer.id || transport.connectionState !== "connected") return;
      if (!this.announcedConnections.has(transport)) {
        this.announcedConnections.add(transport);
        this.callbacks.onNotice(`Connected to ${peer.name || "peer"}.`, "info");
      }
      await this.flushOutbox();
      this.callbacks.onChange();
    })();
    this.connectionWork.set(transport, work);
    try {
      await work;
    } finally {
      // Keep successful work cached for this transport; remove failed work so
      // a later valid lifecycle callback can retry persistence/flush.
      if (!this.announcedConnections.has(transport)) this.connectionWork.delete(transport);
    }
  }

  private async flushOutbox(): Promise<void> {
    const peer = this.activePeer;
    const transport = this.transport;
    if (!peer || !transport || transport.connectionState !== "connected") return;
    const existing = this.flushPromises.get(peer.id);
    if (existing?.transport === transport) return existing.promise;

    const run = (async () => {
      const messages = await this.store.getOutbox();
      for (const message of messages) {
        if (this.transport !== transport || this.activePeer?.id !== peer.id || transport.connectionState !== "connected") break;
        if (message.toPeerId !== peer.id) continue;
        const reset = await this.store.retryMessage(message.id);
        if (reset) await this.transmit(reset, transport);
      }
    })();
    const entry = { transport, promise: run };
    this.flushPromises.set(peer.id, entry);
    try {
      await run;
    } finally {
      if (this.flushPromises.get(peer.id) === entry) this.flushPromises.delete(peer.id);
    }
  }

  private async transmit(message: ChatMessage, expectedTransport = this.transport): Promise<void> {
    const transport = expectedTransport;
    if (!transport || this.transport !== transport || this.activePeer?.id !== message.toPeerId || transport.connectionState !== "connected") {
      await this.store.setMessageStatus(message.id, "pending");
      this.callbacks.onChange();
      return;
    }
    await this.store.setMessageStatus(message.id, "sending");
    this.callbacks.onChange();
    if (this.transport !== transport || this.activePeer?.id !== message.toPeerId || transport.connectionState !== "connected") {
      await this.store.setMessageStatus(message.id, "pending");
      this.callbacks.onChange();
      return;
    }
    try {
      const wire: WireMessage = {
        protocol: "pairwire",
        version: 1,
        type: "message",
        id: message.id,
        conversationId: message.conversationId,
        fromPeerId: message.fromPeerId,
        toPeerId: message.toPeerId,
        text: message.text,
        createdAt: message.createdAt,
      };
      transport.send(encodeFrame(wire));
      await this.store.setMessageStatus(message.id, "sent");
    } catch (error) {
      try {
        await this.store.setMessageStatus(message.id, "failed");
      } catch {
        // Preserve the original transport error; the message remains in the outbox.
      }
      this.callbacks.onNotice(errorMessage(error), "error");
    }
    this.callbacks.onChange();
  }

  private async handleFrame(input: string, sourceTransport: WebRtcTransport): Promise<void> {
    if (this.transport !== sourceTransport) return;
    const local = await this.ensureLocalPeer();
    const frame = decodeFrame(input);
    const peer = sourceTransport.connectedPeer;
    if (!peer || this.activePeer?.id !== peer.id) throw new ProtocolError("Received a frame before a peer was identified.");
    if (frame.toPeerId !== local.id || frame.fromPeerId !== peer.id) {
      throw new ProtocolError("Received a frame for a different peer.");
    }

    if (frame.type === "ack") {
      const original = await this.store.getMessage(frame.messageId);
      if (!original || original.direction !== "outgoing" || original.fromPeerId !== local.id || original.toPeerId !== frame.fromPeerId) return;
      if (this.transport !== sourceTransport || this.activePeer?.id !== peer.id) return;
      await this.store.setMessageStatus(frame.messageId, "delivered");
      this.callbacks.onChange();
      return;
    }

    const incoming: ChatMessage = { ...frame, direction: "incoming", status: "delivered" };
    if (this.transport !== sourceTransport || this.activePeer?.id !== peer.id) return;
    await this.persistPeer(peer);
    await this.store.commitIncoming(incoming);
    const ack = createAcknowledgement({
      messageId: frame.id,
      fromPeerId: local.id,
      toPeerId: frame.fromPeerId,
      persistedAt: Date.now(),
    });
    if (this.transport === sourceTransport && this.activePeer?.id === peer.id && sourceTransport.connectionState === "connected") {
      sourceTransport.send(encodeFrame(ack));
    }
    this.callbacks.onChange();
  }

  private async persistPeer(peer: PeerIdentity): Promise<void> {
    const local = await this.ensureLocalPeer();
    await this.store.savePeer({
      ...peer,
      lastSeenAt: Date.now(),
      conversationId: conversationIdFor(local.id, peer.id),
    });
  }

  private async ensureLocalPeer(): Promise<PeerIdentity> {
    const local = this.localPeer ?? await this.initialize();
    const storedName = await this.store.getStoredDisplayName();
    if (!storedName) throw new Error("Choose your display name before connecting or sending messages.");
    if (local.name !== storedName) this.localPeer = { ...local, name: storedName };
    return this.localPeer!;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
