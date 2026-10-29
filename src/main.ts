import { MessagingService } from "./core/messaging-service.js";
import type { ChatMessage, ConnectionState, PeerIdentity, PeerRecord } from "./core/types.js";
import { conversationIdFor, MAX_TEXT_LENGTH } from "./core/types.js";
import { PairwireStore } from "./storage/indexed-db.js";

const store = new PairwireStore();
let localPeer: PeerIdentity | null = null;
let selectedPeerId: string | null = null;
let lastConnectedPeerId: string | null = null;
let renderSequence = 0;
let sendingMessage = false;

const elements = {
  newConnection: byId<HTMLButtonElement>("new-connection-button"),
  welcomeNew: byId<HTMLButtonElement>("welcome-new-button"),
  welcomeJoin: byId<HTMLButtonElement>("welcome-join-button"),
  conversationList: byId<HTMLDivElement>("conversation-list"),
  conversationCount: byId<HTMLSpanElement>("conversation-count"),
  displayName: byId<HTMLInputElement>("display-name"),
  profileAvatar: byId<HTMLDivElement>("profile-avatar"),
  activeAvatar: byId<HTMLDivElement>("active-avatar"),
  activeTitle: byId<HTMLHeadingElement>("active-title"),
  connectionDot: byId<HTMLSpanElement>("connection-dot"),
  connectionLabel: byId<HTMLSpanElement>("connection-label"),
  welcomePanel: byId<HTMLElement>("welcome-panel"),
  chatPanel: byId<HTMLElement>("chat-panel"),
  chatHistory: byId<HTMLDivElement>("chat-history"),
  composerHint: byId<HTMLDivElement>("composer-hint"),
  messageForm: byId<HTMLFormElement>("message-form"),
  messageInput: byId<HTMLTextAreaElement>("message-input"),
  messageCount: byId<HTMLSpanElement>("message-count"),
  sendButton: byId<HTMLButtonElement>("send-button"),
  pairingDialog: byId<HTMLDialogElement>("pairing-dialog"),
  closePairing: byId<HTMLButtonElement>("close-pairing-button"),
  createTab: byId<HTMLButtonElement>("create-tab"),
  joinTab: byId<HTMLButtonElement>("join-tab"),
  createView: byId<HTMLElement>("create-view"),
  joinView: byId<HTMLElement>("join-view"),
  createInvitation: byId<HTMLButtonElement>("create-invitation-button"),
  invitationOutput: byId<HTMLTextAreaElement>("invitation-output"),
  copyInvitation: byId<HTMLButtonElement>("copy-invitation-button"),
  responseInput: byId<HTMLTextAreaElement>("response-input"),
  completePairing: byId<HTMLButtonElement>("complete-pairing-button"),
  joinInput: byId<HTMLTextAreaElement>("join-input"),
  acceptInvitation: byId<HTMLButtonElement>("accept-invitation-button"),
  responseOutput: byId<HTMLTextAreaElement>("response-output"),
  copyResponse: byId<HTMLButtonElement>("copy-response-button"),
  detailsDialog: byId<HTMLDialogElement>("details-dialog"),
  detailsButton: byId<HTMLButtonElement>("connection-details-button"),
  closeDetails: byId<HTMLButtonElement>("close-details-button"),
  detailConnection: byId<HTMLElement>("detail-connection"),
  detailPeer: byId<HTMLElement>("detail-peer"),
  disconnect: byId<HTMLButtonElement>("disconnect-button"),
  toastRegion: byId<HTMLDivElement>("toast-region"),
};

const messaging = new MessagingService(store, {
  onChange: () => void render(),
  onNotice: (message, kind = "info") => showToast(message, kind),
});

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing required element #${id}.`);
  return element as T;
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  const toast = document.createElement("div");
  toast.className = kind === "error" ? "toast is-error" : "toast";
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4_500);
}

function openPairing(mode: "create" | "join"): void {
  setPairingMode(mode);
  if (!elements.pairingDialog.open) elements.pairingDialog.showModal();
}

function setPairingMode(mode: "create" | "join"): void {
  const create = mode === "create";
  elements.createTab.classList.toggle("is-active", create);
  elements.createTab.setAttribute("aria-selected", String(create));
  elements.joinTab.classList.toggle("is-active", !create);
  elements.joinTab.setAttribute("aria-selected", String(!create));
  elements.createView.classList.toggle("hidden", !create);
  elements.joinView.classList.toggle("hidden", create);
}

async function withButtonBusy<T>(button: HTMLButtonElement, action: () => Promise<T>): Promise<T | undefined> {
  const previous = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await action();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Something went wrong.", "error");
    return undefined;
  } finally {
    button.innerHTML = previous;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function copyText(value: string, label: string): Promise<void> {
  if (!value.trim()) {
    showToast("Generate the pairing text first.", "error");
    return;
  }
  if (!navigator.clipboard?.writeText) {
    showToast("Clipboard access is unavailable. Select the text and copy it manually.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    showToast(`${label} copied to clipboard.`);
  } catch {
    showToast("Clipboard access was denied. Select the text and copy it manually.", "error");
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.length === 1
    ? parts[0]!.slice(0, 1).toLocaleUpperCase()
    : `${parts[0]!.slice(0, 1)}${parts.at(-1)!.slice(0, 1)}`.toLocaleUpperCase();
}

function connectionDescription(state: string): string {
  const labels: Record<string, string> = {
    new: "No active connection",
    connecting: "Establishing direct connection…",
    connected: "Connected directly",
    disconnected: "Connection interrupted",
    failed: "Connection failed",
    closed: "Connection closed",
  };
  return labels[state] ?? "No active connection";
}

function prettyTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function statusLabel(status: ChatMessage["status"]): string {
  const labels: Record<ChatMessage["status"], string> = {
    pending: "Queued",
    sending: "Sending",
    sent: "Sent · waiting for receipt",
    delivered: "Delivered",
    failed: "Not sent",
  };
  return labels[status];
}

async function render(): Promise<void> {
  const sequence = ++renderSequence;
  try {
    const [peers, conversations] = await Promise.all([messaging.getPeers(), messaging.getConversations()]);
    if (sequence !== renderSequence) return;

    const connectedPeer = messaging.connectedPeer;
    if (connectedPeer && connectedPeer.id !== lastConnectedPeerId) {
      selectedPeerId = connectedPeer.id;
      lastConnectedPeerId = connectedPeer.id;
    }
    const peerById = new Map<string, PeerRecord>(peers.map((peer) => [peer.id, peer]));
    if (!selectedPeerId || (!peerById.has(selectedPeerId) && !connectedPeer)) {
      selectedPeerId = peers[0]?.id ?? null;
    }
    const selectedPeer = (selectedPeerId ? peerById.get(selectedPeerId) : undefined) ??
      (connectedPeer?.id === selectedPeerId ? { ...connectedPeer, lastSeenAt: Date.now(), conversationId: conversationIdFor(localPeer!.id, connectedPeer.id) } : undefined);

    elements.conversationCount.textContent = String(peers.length);
    elements.conversationList.replaceChildren();
    if (peers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "Your people will show up here.";
      elements.conversationList.append(empty);
    } else {
      const latestByConversation = new Map<string, string>();
      for (const conversation of conversations) {
        if (conversation.lastMessage) latestByConversation.set(conversation.id, conversation.lastMessage);
      }
      for (const peer of [...peers].sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `conversation-item${peer.id === selectedPeerId ? " is-selected" : ""}`;
        button.setAttribute("aria-pressed", String(peer.id === selectedPeerId));
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = initials(peer.name);
        const copy = document.createElement("span");
        copy.className = "conversation-copy";
        const name = document.createElement("span");
        name.className = "conversation-name";
        name.textContent = peer.name;
        const preview = document.createElement("span");
        preview.className = "conversation-preview";
        preview.textContent = latestByConversation.get(peer.conversationId) ?? "Direct conversation";
        copy.append(name, preview);
        button.append(avatar, copy);
        button.addEventListener("click", () => {
          selectedPeerId = peer.id;
          void render();
        });
        elements.conversationList.append(button);
      }
    }

    const state = messaging.connectionState;
    const isConnectedToSelection = state === "connected" && connectedPeer?.id === selectedPeerId;
    const hasSelectedPeer = Boolean(selectedPeer);
    elements.activeTitle.textContent = selectedPeer?.name ?? "Direct, by design.";
    elements.activeAvatar.textContent = selectedPeer ? initials(selectedPeer.name) : "↔";
    elements.connectionLabel.textContent = connectedPeer && connectedPeer.id !== selectedPeerId
      ? `Connected to ${connectedPeer.name}`
      : connectionDescription(state);
    elements.connectionDot.classList.toggle("is-connected", isConnectedToSelection);
    elements.connectionDot.classList.toggle("is-connecting", state === "connecting");
    elements.welcomePanel.classList.toggle("hidden", hasSelectedPeer);
    elements.chatPanel.classList.toggle("hidden", !hasSelectedPeer);
    elements.messageInput.disabled = !isConnectedToSelection;
    elements.sendButton.disabled = sendingMessage || !isConnectedToSelection || !elements.messageInput.value.trim();
    elements.composerHint.textContent = isConnectedToSelection
      ? "Messages save locally first. Delivered means the other browser confirmed persistence."
      : connectedPeer && connectedPeer.id !== selectedPeerId
        ? `Reconnect to ${selectedPeer?.name ?? "this peer"} to send a message.`
        : "Your history stays on this device. Connect to this peer to send a message.";

    elements.detailConnection.textContent = connectionDescription(state);
    elements.detailPeer.textContent = connectedPeer?.name ?? "—";
    elements.disconnect.disabled = !connectedPeer;

    if (selectedPeer && localPeer) {
      await renderMessages(conversationIdFor(localPeer.id, selectedPeer.id), sequence);
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not refresh the conversation view.", "error");
  }
}

async function renderMessages(conversationId: string, sequence: number): Promise<void> {
  const messages = await messaging.getMessages(conversationId);
  if (sequence !== renderSequence) return;
  const fragment = document.createDocumentFragment();
  const start = document.createElement("div");
  start.className = "history-start";
  const firstLine = document.createElement("span");
  const secondLine = document.createElement("span");
  const startText = document.createElement("p");
  startText.textContent = messages.length ? "Conversation history" : "This is the beginning of your conversation.";
  start.append(firstLine, startText, secondLine);
  fragment.append(start);

  for (const message of messages) {
    const outgoing = message.direction === "outgoing";
    const row = document.createElement("article");
    row.className = `message-row${outgoing ? " is-outgoing" : ""}`;
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = outgoing ? "Y" : initials(messaging.connectedPeer?.name ?? "P");
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("span");
    sender.textContent = outgoing ? "You" : "Peer";
    const time = document.createElement("time");
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = prettyTime(message.createdAt);
    meta.append(sender, time);
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.text;
    content.append(meta, bubble);
    if (outgoing) {
      const status = document.createElement("div");
      status.className = "message-meta message-status";
      status.textContent = statusLabel(message.status);
      if (message.status === "failed") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "retry-message";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => {
          void withButtonBusy(retry, () => messaging.retryMessage(message.id));
        });
        status.append(retry);
      }
      content.append(status);
    }
    if (outgoing) row.append(content, avatar);
    else row.append(avatar, content);
    fragment.append(row);
  }
  elements.chatHistory.replaceChildren(fragment);
  elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
}

function updateMessageCounter(): void {
  const length = elements.messageInput.value.length;
  elements.messageCount.textContent = `${length.toLocaleString()} / ${MAX_TEXT_LENGTH.toLocaleString()}`;
  elements.sendButton.disabled = sendingMessage || elements.messageInput.disabled || !elements.messageInput.value.trim();
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 150)}px`;
}

elements.newConnection.addEventListener("click", () => openPairing("create"));
elements.welcomeNew.addEventListener("click", () => openPairing("create"));
elements.welcomeJoin.addEventListener("click", () => openPairing("join"));
elements.closePairing.addEventListener("click", () => elements.pairingDialog.close());
elements.createTab.addEventListener("click", () => setPairingMode("create"));
elements.joinTab.addEventListener("click", () => setPairingMode("join"));
elements.copyInvitation.addEventListener("click", () => void copyText(elements.invitationOutput.value, "Invitation"));
elements.copyResponse.addEventListener("click", () => void copyText(elements.responseOutput.value, "Response"));

elements.createInvitation.addEventListener("click", () => {
  void withButtonBusy(elements.createInvitation, async () => {
    const text = await messaging.createInvitation();
    elements.invitationOutput.value = text;
    elements.copyInvitation.disabled = false;
    elements.responseInput.value = "";
    showToast("Invitation ready. Share it with your peer.");
    return text;
  });
});

elements.acceptInvitation.addEventListener("click", () => {
  void withButtonBusy(elements.acceptInvitation, async () => {
    const response = await messaging.acceptInvitation(elements.joinInput.value);
    elements.responseOutput.value = response;
    elements.copyResponse.disabled = false;
    showToast("Response ready. Send it back to the person who invited you.");
    return response;
  });
});

elements.completePairing.addEventListener("click", () => {
  void withButtonBusy(elements.completePairing, async () => {
    await messaging.completePairing(elements.responseInput.value);
    showToast("Response accepted. Establishing the direct connection…");
  });
});

elements.detailsButton.addEventListener("click", () => elements.detailsDialog.showModal());
elements.closeDetails.addEventListener("click", () => elements.detailsDialog.close());
elements.disconnect.addEventListener("click", () => {
  messaging.closeConnection();
  elements.detailsDialog.close();
  showToast("Connection closed. History and pending messages remain on this device.");
});

elements.displayName.addEventListener("change", () => {
  void withButtonBusyName(async () => {
    localPeer = await messaging.updateDisplayName(elements.displayName.value);
    elements.displayName.value = localPeer.name;
    elements.profileAvatar.textContent = initials(localPeer.name);
    showToast("Display name saved for future pairings.");
  });
});

async function withButtonBusyName(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not save your display name.", "error");
  }
}

elements.messageInput.addEventListener("input", updateMessageCounter);
elements.messageInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.messageForm.requestSubmit();
  }
});
elements.messageForm.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  if (sendingMessage) return;
  const text = elements.messageInput.value;
  if (!text.trim()) return;
  sendingMessage = true;
  updateMessageCounter();
  void messaging.sendMessage(text)
    .then(() => {
      elements.messageInput.value = "";
      elements.messageInput.focus();
    })
    .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Message could not be sent.", "error"))
    .finally(() => {
      sendingMessage = false;
      updateMessageCounter();
    });
});

async function main(): Promise<void> {
  if (!("RTCPeerConnection" in window)) {
    showToast("This browser does not support WebRTC data channels.", "error");
    elements.newConnection.disabled = true;
    elements.welcomeNew.disabled = true;
    elements.welcomeJoin.disabled = true;
    return;
  }
  if (!("indexedDB" in window)) {
    showToast("This browser does not support local message storage.", "error");
    return;
  }
  localPeer = await messaging.initialize();
  elements.displayName.value = localPeer.name;
  elements.profileAvatar.textContent = initials(localPeer.name);
  const peers = await messaging.getPeers();
  selectedPeerId = peers[0]?.id ?? null;
  updateMessageCounter();
  await render();
}

void main().catch((error: unknown) => {
  showToast(error instanceof Error ? error.message : "Pairwire could not start.", "error");
});
