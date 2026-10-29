import { createAcknowledgement, createWireMessage, decodeFrame, encodeFrame, ProtocolError } from "./protocol.js";
import type { ChatMessage, MessageStatus, PeerIdentity, WireMessage } from "./types.js";
import { conversationIdFor, MAX_TEXT_LENGTH } from "./types.js";
import { PairwireStore } from "../storage/indexed-db.js";
import { WebRtcTransport } from "../transport/webrtc.js";

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
  private flushPromise: Promise<void> | null = null;

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

  async updateDisplayName(name: string): Promise<PeerIdentity> {
    await this.store.setDisplayName(name);
    if (!this.localPeer) return this.initialize();
    this.localPeer = { ...this.localPeer, name: await this.store.getDisplayName() };
    return this.localPeer;
  }

  async createInvitation(): Promise<string> {
    const local = await this.ensureLocalPeer();
    const transport = this.createTransport();
    return transport.createInvitation(local);
  }

  async acceptInvitation(input: string): Promise<string> {
    const local = await this.ensureLocalPeer();
    const transport = this.createTransport();
    return transport.acceptInvitation(input, local);
  }

  async completePairing(input: string): Promise<void> {
    const local = await this.ensureLocalPeer();
    if (!this.transport) throw new Error("Create an invitation before importing a response.");
    await this.transport.completePairing(input, local.id);
    this.callbacks.onChange();
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

  async selectPeer(peer: PeerIdentity): Promise<void> {
    this.activePeer = peer;
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
    const transport = new WebRtcTransport({
      onStateChange: (state) => {
        if (state === "connected") {
          void this.onConnected().catch((error: unknown) => {
            this.callbacks.onNotice(errorMessage(error), "error");
          });
        }
        if (state === "failed" || state === "disconnected") {
          this.callbacks.onNotice("Connection interrupted. Pending messages stay on this device.", "info");
        }
        this.callbacks.onChange();
      },
      onData: (data) => {
        this.processing = this.processing
          .then(() => this.handleFrame(data))
          .catch((error: unknown) => {
            this.callbacks.onNotice(errorMessage(error), "error");
          });
      },
      onRemotePeer: (peer) => {
        this.activePeer = peer;
        void this.persistPeer(peer)
          .then(() => this.callbacks.onChange())
          .catch((error: unknown) => this.callbacks.onNotice(errorMessage(error), "error"));
        this.callbacks.onChange();
      },
      onError: (error) => this.callbacks.onNotice(error.message, "error"),
    });
    this.transport = transport;
    return transport;
  }

  private async onConnected(): Promise<void> {
    const peer = this.activePeer;
    if (peer) {
      await this.persistPeer(peer);
      this.callbacks.onNotice(`Connected to ${peer.name || "peer"}.`, "info");
    }
    await this.flushOutbox();
    this.callbacks.onChange();
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const peer = this.activePeer;
    if (!peer || this.connectionState !== "connected") return;
    const run = (async () => {
      const messages = await this.store.getOutbox();
      for (const message of messages) {
        if (this.connectionState !== "connected" || this.activePeer?.id !== peer.id) break;
        if (message.toPeerId !== peer.id) continue;
        const reset = await this.store.retryMessage(message.id);
        if (reset) await this.transmit(reset);
      }
    })();
    this.flushPromise = run;
    try {
      await run;
    } finally {
      if (this.flushPromise === run) this.flushPromise = null;
    }
  }

  private async transmit(message: ChatMessage): Promise<void> {
    const transport = this.transport;
    if (!transport || transport.connectionState !== "connected") {
      await this.store.setMessageStatus(message.id, "pending");
      this.callbacks.onChange();
      return;
    }
    await this.store.setMessageStatus(message.id, "sending");
    this.callbacks.onChange();
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

  private async handleFrame(input: string): Promise<void> {
    const local = await this.ensureLocalPeer();
    const frame = decodeFrame(input);
    const peer = this.activePeer;
    if (!peer) throw new ProtocolError("Received a frame before a peer was identified.");
    if (frame.toPeerId !== local.id || frame.fromPeerId !== peer.id) {
      throw new ProtocolError("Received a frame for a different peer.");
    }

    if (frame.type === "ack") {
      const messages = await this.store.getMessages(conversationIdFor(local.id, peer.id));
      const original = messages.find((message) => message.id === frame.messageId);
      if (!original || original.direction !== "outgoing" || original.toPeerId !== frame.fromPeerId) return;
      await this.store.setMessageStatus(frame.messageId, "delivered");
      this.callbacks.onChange();
      return;
    }

    const incoming: ChatMessage = { ...frame, direction: "incoming", status: "delivered" };
    await this.persistPeer(peer);
    await this.store.commitIncoming(incoming);
    const ack = {
      protocol: "pairwire" as const,
      version: 1 as const,
      type: "ack" as const,
      messageId: frame.id,
      fromPeerId: local.id,
      toPeerId: frame.fromPeerId,
      persistedAt: Date.now(),
    };
    this.transport?.send(encodeFrame(ack));
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
    return this.localPeer ?? this.initialize();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
