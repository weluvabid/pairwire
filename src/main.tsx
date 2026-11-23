import { render } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import "./styles.css";
import { MessagingService } from "./core/messaging-service.js";
import type { ChatMessage, PeerIdentity, PeerRecord } from "./core/types.js";
import { conversationIdFor, MAX_TEXT_LENGTH } from "./core/types.js";
import { decodeSignaling } from "./core/protocol.js";
import { PairwireStore } from "./storage/indexed-db.js";

type Notice = { id: number; message: string; kind: "info" | "error" };
type PairingMode = "create" | "join";

const store = new PairwireStore();
let notifyChange: (() => void) | undefined;
const messaging = new MessagingService(store, {
  onChange: () => notifyChange?.(),
  onNotice: (message, kind = "info") => window.dispatchEvent(new CustomEvent("pairwire:notice", { detail: { message, kind } })),
});

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.length === 1 ? parts[0]!.slice(0, 1).toLocaleUpperCase() : `${parts[0]!.slice(0, 1)}${parts.at(-1)!.slice(0, 1)}`.toLocaleUpperCase();
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

function useMessagingRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((current) => current + 1);
    notifyChange = update;
    return () => {
      if (notifyChange === update) notifyChange = undefined;
    };
  }, []);
  return revision;
}

function App() {
  const revision = useMessagingRevision();
  const [localPeer, setLocalPeer] = useState<PeerIdentity | null>(null);
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Awaited<ReturnType<typeof messaging.getConversations>>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outbox, setOutbox] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [nameSetupOpen, setNameSetupOpen] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const sendingRef = useRef(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PeerRecord | null>(null);
  const [pairingMode, setPairingMode] = useState<PairingMode>("create");
  const [reconnectPeerId, setReconnectPeerId] = useState<string | null>(null);
  const [invitationOutput, setInvitationOutput] = useState("");
  const [responseInput, setResponseInput] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [responseOutput, setResponseOutput] = useState("");
  const [invitationCreated, setInvitationCreated] = useState(false);
  const [clipboardFallback, setClipboardFallback] = useState<"join" | "response" | "invitation-copy" | "response-copy" | null>(null);
  const [clipboardFallbackText, setClipboardFallbackText] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastRenderedConversation = useRef<string | null>(null);
  const previousScroll = useRef({ height: 0, top: 0, nearBottom: true });
  const toastId = useRef(0);
  const connectedPeer = messaging.connectedPeer;
  const connectionState = messaging.connectionState;

  useEffect(() => {
    if (!pairingOpen || !reconnectPeerId || connectionState !== "connected" || connectedPeer?.id !== reconnectPeerId) return;
    setPairingOpen(false);
    setReconnectPeerId(null);
  }, [pairingOpen, reconnectPeerId, connectionState, connectedPeer?.id]);

  const showToast = useCallback((message: string, kind: "info" | "error" = "info") => {
    const id = ++toastId.current;
    setNotices((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 4500);
  }, []);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; kind?: "info" | "error" }>).detail;
      showToast(detail.message, detail.kind ?? "info");
    };
    window.addEventListener("pairwire:notice", onNotice);
    return () => window.removeEventListener("pairwire:notice", onNotice);
  }, [showToast]);

  useEffect(() => {
    if (!("RTCPeerConnection" in window)) {
      showToast("This browser does not support WebRTC data channels.", "error");
      return;
    }
    if (!("indexedDB" in window)) {
      showToast("This browser does not support local message storage.", "error");
      return;
    }
    let cancelled = false;
    void messaging.initialize().then(async (identity) => {
      if (cancelled) return;
      setLocalPeer(identity);
      const [storedName, storedPeers] = await Promise.all([messaging.getStoredDisplayName(), messaging.getPeers()]);
      if (cancelled) return;
      setSelectedPeerId(storedPeers[0]?.id ?? null);
      if (!storedName) setNameSetupOpen(true);
    }).catch((error: unknown) => showToast(error instanceof Error ? error.message : "Pairwire could not start.", "error"));
    return () => { cancelled = true; };
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([messaging.getPeers(), messaging.getConversations(), messaging.getOutbox()]).then(([nextPeers, nextConversations, nextOutbox]) => {
      if (cancelled) return;
      setPeers(nextPeers);
      setConversations(nextConversations);
      setOutbox(nextOutbox);
      if (connectedPeer) setSelectedPeerId(connectedPeer.id);
      else if (selectedPeerId && !nextPeers.some((peer) => peer.id === selectedPeerId)) setSelectedPeerId(nextPeers[0]?.id ?? null);
      else if (!selectedPeerId && nextPeers.length) setSelectedPeerId(nextPeers[0]!.id);
    }).catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not load conversations.", "error"));
    return () => { cancelled = true; };
  }, [revision, connectedPeer?.id, selectedPeerId, showToast]);

  const selectedPeer = useMemo(() => {
    const stored = peers.find((peer) => peer.id === selectedPeerId);
    if (stored) return stored;
    if (connectedPeer && connectedPeer.id === selectedPeerId && localPeer) {
      return { ...connectedPeer, lastSeenAt: Date.now(), conversationId: conversationIdFor(localPeer.id, connectedPeer.id) } satisfies PeerRecord;
    }
    return undefined;
  }, [peers, selectedPeerId, connectedPeer?.id, connectedPeer?.name, localPeer]);

  useEffect(() => {
    if (!selectedPeer || !localPeer) {
      setMessages([]);
      lastRenderedConversation.current = null;
      return;
    }
    const conversationId = conversationIdFor(localPeer.id, selectedPeer.id);
    let cancelled = false;
    const history = historyRef.current;
    const oldHeight = history?.scrollHeight ?? 0;
    const oldTop = history?.scrollTop ?? 0;
    const isNewConversation = lastRenderedConversation.current !== conversationId;
    const nearBottom = !history || isNewConversation || oldHeight - oldTop - history.clientHeight < 88;
    previousScroll.current = { height: oldHeight, top: oldTop, nearBottom };
    void messaging.getMessages(conversationId).then((next) => {
      if (!cancelled) {
        setMessages(next);
        lastRenderedConversation.current = conversationId;
      }
    }).catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not load messages.", "error"));
    return () => { cancelled = true; };
  }, [selectedPeer?.id, localPeer?.id, revision, showToast]);

  useEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const { height, top, nearBottom } = previousScroll.current;
    if (nearBottom) history.scrollTop = history.scrollHeight;
    else history.scrollTop = top + (history.scrollHeight - height);
  }, [messages]);

  useEffect(() => {
    const input = messageInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 64), 144)}px`;
  }, [draft]);

  const isConnectedToSelection = connectionState === "connected" && connectedPeer?.id === selectedPeerId;
  const pendingForSelection = selectedPeerId ? outbox.filter((message) => message.toPeerId === selectedPeerId) : [];
  const reconnectingPeer = reconnectPeerId ? peers.find((peer) => peer.id === reconnectPeerId) : undefined;
  const composerHint = isConnectedToSelection
    ? "Messages save locally first. Delivered means the other browser confirmed persistence."
    : connectedPeer && connectedPeer.id !== selectedPeerId
      ? `Reconnect to ${selectedPeer?.name ?? "this peer"} to send a message.`
      : "Your history stays on this device. Connect to this peer to send a message.";

  const withBusy = async (key: string, action: () => Promise<void>) => {
    if (busyActionRef.current) return;
    busyActionRef.current = key;
    setBusyAction(key);
    try { await action(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Something went wrong.", "error"); }
    finally { busyActionRef.current = null; setBusyAction(null); }
  };

  const openPairing = (mode: PairingMode) => {
    setReconnectPeerId(null);
    setPairingMode(mode);
    setInvitationOutput("");
    setResponseInput("");
    setJoinInput("");
    setResponseOutput("");
    setInvitationCreated(false);
    setClipboardFallback(null);
    setClipboardFallbackText("");
    setPairingOpen(true);
  };

  const reconnectToPeer = (peer: PeerRecord) => {
    if (connectedPeer && connectedPeer.id !== peer.id) {
      showToast(`Pairwire supports one active connection. Reconnecting to ${peer.name} will close the connection to ${connectedPeer.name}.`);
    }
    setSelectedPeerId(peer.id);
    setReconnectPeerId(peer.id);
    setPairingMode("create");
    setInvitationOutput("");
    setResponseInput("");
    setJoinInput("");
    setResponseOutput("");
    setInvitationCreated(false);
    setClipboardFallback(null);
    setClipboardFallbackText("");
    setDetailsOpen(false);
    setMobileDrawerOpen(false);
    setPairingOpen(true);
  };

  const confirmDeleteConversation = async () => {
    if (!deleteTarget || !localPeer) return;
    const target = deleteTarget;
    await withBusy(`delete:${target.id}`, async () => {
      const conversationId = conversationIdFor(localPeer.id, target.id);
      await messaging.deleteConversation(target.id, conversationId);
      setDeleteTarget(null);
      if (selectedPeerId === target.id) {
        const nextPeer = peers.find((peer) => peer.id !== target.id);
        setSelectedPeerId(nextPeer?.id ?? null);
      }
      showToast(`Conversation with ${target.name} deleted from this device.`);
    });
  };

  const writeClipboard = async (value: string, label: string, fallback: "invitation-copy" | "response-copy", successMessage?: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard writing is unavailable in this browser context.");
      await navigator.clipboard.writeText(value);
      setClipboardFallback(null);
      setClipboardFallbackText("");
      showToast(successMessage ?? `${label} copied. Share it with your peer.`);
      return true;
    } catch (error) {
      setClipboardFallback(fallback);
      setClipboardFallbackText(value);
      showToast(error instanceof Error ? `${error.message} You can copy the text manually below.` : "Clipboard access was denied. You can copy the text manually below.", "error");
      return false;
    }
  };

  const readClipboard = async (expectedType: "pairwire-invitation" | "pairwire-response", fallback: "join" | "response"): Promise<string | null> => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard reading is unavailable. Paste the pairing text manually instead.");
      const value = await navigator.clipboard.readText();
      if (!value.trim()) throw new Error("Your clipboard is empty. Copy the pairing text first, or paste it manually.");
      decodeSignaling(value, expectedType);
      setClipboardFallback(null);
      setClipboardFallbackText("");
      return value;
    } catch (error) {
      setClipboardFallback(fallback);
      setClipboardFallbackText("");
      showToast(error instanceof Error ? error.message : "Could not read valid pairing text from the clipboard.", "error");
      return null;
    }
  };

  const acceptInvitationText = async (value: string) => {
    decodeSignaling(value, "pairwire-invitation");
    const response = await messaging.acceptInvitation(value, reconnectPeerId ?? undefined);
    setJoinInput("");
    const copied = await writeClipboard(response, "Response", "response-copy");
    setResponseOutput(copied ? "" : response);
  };

  const completeWithResponse = async (value: string) => {
    decodeSignaling(value, "pairwire-response");
    await messaging.completePairing(value, reconnectPeerId ?? undefined);
    setResponseInput("");
    setClipboardFallback(null);
    showToast("Response accepted. Establishing the direct connection…");
  };

  const createAndCopyInvitation = async () => {
    // Each invitation owns a fresh RTCPeerConnection. Creating another one
    // intentionally replaces the previous pending invitation.
    setInvitationOutput("");
    setResponseInput("");
    setInvitationCreated(false);
    const value = await messaging.createInvitation();
    setInvitationCreated(true);
    const copied = await writeClipboard(
      value,
      "Invitation",
      "invitation-copy",
      "New invitation copied. It replaces any earlier invitation; share this one with your peer.",
    );
    setInvitationOutput(copied ? "" : value);
  };

  const readAndAcceptInvitation = async () => {
    const value = await readClipboard("pairwire-invitation", "join");
    if (value) await acceptInvitationText(value);
  };

  const readAndCompletePairing = async () => {
    const value = await readClipboard("pairwire-response", "response");
    if (value) await completeWithResponse(value);
  };

  const saveDisplayName = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = displayNameDraft.trim();
    if (!name || nameSaving) return;
    setNameSaving(true);
    try {
      const identity = await messaging.updateDisplayName(name);
      setLocalPeer(identity);
      setNameSetupOpen(false);
      showToast(`You're all set, ${identity.name}.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save your display name.", "error");
    } finally {
      setNameSaving(false);
    }
  };

  const sendMessage = async (event: SubmitEvent) => {
    event.preventDefault();
    if (sendingRef.current || !draft.trim() || !isConnectedToSelection) return;
    sendingRef.current = true;
    setSending(true);
    try { await messaging.sendMessage(draft); setDraft(""); }
    catch (error) { showToast(error instanceof Error ? error.message : "Message could not be sent.", "error"); }
    finally { sendingRef.current = false; setSending(false); }
  };

  return (
    <div class="drawer lg:drawer-open app-drawer">
      <input id="pairwire-drawer" type="checkbox" class="drawer-toggle" checked={mobileDrawerOpen} onChange={(event) => setMobileDrawerOpen((event.currentTarget as HTMLInputElement).checked)} />
      <div class="drawer-content app-content">
        <main class="main-panel">
          <div class="mobile-context lg:hidden">
            <label htmlFor="pairwire-drawer" class="btn btn-ghost btn-square btn-sm" aria-label="Open conversations">☰</label>
            {selectedPeer && <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold">{selectedPeer.name}</div>
              <div class="flex items-center gap-2 text-xs text-base-content/55"><ConnectionDot peer={selectedPeer} connected={isConnectedToSelection} connecting={reconnectPeerId === selectedPeer.id && connectionState === "connecting"} failed={reconnectPeerId === selectedPeer.id && connectionState === "failed"} /><span>{peerConnectionLabel(isConnectedToSelection, reconnectPeerId === selectedPeer.id ? connectionState : "disconnected")}</span></div>
            </div>}
          </div>

          {!selectedPeer ? (
            <Welcome onCreate={() => openPairing("create")} onJoin={() => openPairing("join")} />
          ) : (
            <section class="chat-panel" aria-label="Conversation">
              <div class="chat-history" ref={historyRef} aria-live="polite">
                <div class="history-start"><span /><p>{messages.length ? "Conversation history" : "This is the beginning of your conversation."}</p><span /></div>
                {!isConnectedToSelection && <div class="alert alert-warning mx-auto mb-4 max-w-xl text-xs"><span>{selectedPeer.name} is disconnected. Your local history is safe; reconnect to continue this conversation.</span></div>}
                {pendingForSelection.length > 0 && <div class="alert alert-info mx-auto mb-4 max-w-xl text-xs"><span>{pendingForSelection.length} {pendingForSelection.length === 1 ? "message is" : "messages are"} waiting for delivery. They will be retried when you reconnect.</span></div>}
                {messages.map((message) => <Message key={message.id} message={message} peerName={connectedPeer?.name ?? selectedPeer.name} onRetry={() => void withBusy(`retry:${message.id}`, () => messaging.retryMessage(message.id))} retryBusy={busyAction === `retry:${message.id}`} />)}
              </div>
              <div class="composer-wrap">
                <div class="composer-hint">{composerHint}</div>
                <form class="rounded-xl border border-base-300 bg-base-100 p-3 shadow-sm focus-within:border-success/40 focus-within:shadow-md" onSubmit={(event) => void sendMessage(event as unknown as SubmitEvent)}>
                  <label class="sr-only" htmlFor="message-input">Write a message</label>
                  <textarea ref={messageInputRef} id="message-input" class="textarea textarea-ghost min-h-16 max-h-36 w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-xs leading-relaxed focus:outline-none" name="message" rows={1} maxLength={MAX_TEXT_LENGTH} placeholder="Write something thoughtful…" value={draft} disabled={!isConnectedToSelection} onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit(); } }} />
                  <div class="flex items-center justify-between border-t border-base-200 pt-2">
                    <span class="font-mono text-[.62rem] text-base-content/50">{draft.length.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}</span>
                    <button class="btn btn-primary btn-sm" type="submit" disabled={sending || !isConnectedToSelection || !draft.trim()}>{sending ? <span class="loading loading-spinner loading-xs" /> : "Send ↑"}</button>
                  </div>
                </form>
                <div class="mt-2 flex justify-end gap-3 text-[.55rem] text-base-content/40"><span>Enter to send</span><span>Shift + Enter for a new line</span></div>
              </div>
            </section>
          )}
          <footer class="main-footer"><span><span class="footer-led" /> A small experiment in direct communication</span><span>Pairwire <span class="footer-divider">/</span> v0.1.0</span></footer>
        </main>
      </div>
      <div class="drawer-side z-40">
        <label htmlFor="pairwire-drawer" aria-label="Close conversations" class="drawer-overlay" />
        <aside class="sidebar" aria-label="Conversations">
          <div class="sidebar-header">
            <div class="brand-row"><div class="brand-mark" aria-hidden="true"><span /><span /><span /></div><div class="min-w-0"><div class="brand-name">pairwire<span class="brand-period">.</span></div><div class="brand-caption">A little more direct.</div>{localPeer && <div class="brand-user" title={`This device is using the name ${localPeer.name}`}>Using as <strong>{localPeer.name}</strong></div>}</div></div>
            <div class="sidebar-actions"><button class="btn btn-primary btn-sm w-full" type="button" onClick={() => { setMobileDrawerOpen(false); openPairing("create"); }}>＋ New connection</button></div>
            <div class="sidebar-section-heading"><span>CONVERSATIONS</span><span class="badge badge-ghost">{peers.length}</span></div>
          </div>
          <ul class="menu conversation-list">
            {peers.length === 0 ? <li class="menu-disabled"><span>Your people will show up here.</span></li> : [...peers].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((peer) => {
              const preview = conversations.find((conversation) => conversation.id === peer.conversationId)?.lastMessage ?? "Direct conversation";
              const queuedCount = outbox.filter((message) => message.toPeerId === peer.id).length;
              const peerConnected = connectionState === "connected" && connectedPeer?.id === peer.id;
              const peerConnecting = reconnectPeerId === peer.id && connectionState === "connecting";
              const peerFailed = reconnectPeerId === peer.id && connectionState === "failed";
              return <li key={peer.id} class="conversation-entry">
                <div class={`conversation-row ${peer.id === selectedPeerId ? "is-selected" : ""}`}>
                  <button type="button" class="conversation-select" aria-pressed={peer.id === selectedPeerId} onClick={() => { setSelectedPeerId(peer.id); setMobileDrawerOpen(false); }}>
                    <div class="avatar placeholder conversation-avatar"><div><span>{initials(peer.name)}</span></div></div>
                    <span class="conversation-copy"><span class="conversation-name">{peer.name}</span><span class="conversation-preview">{preview}</span></span>
                    {queuedCount > 0 && <span class="badge badge-warning badge-xs" title={`${queuedCount} messages waiting for delivery`}>{queuedCount}</span>}
                  </button>
                  <div class="conversation-controls">
                    <ConnectionDot peer={peer} connected={peerConnected} connecting={peerConnecting} failed={peerFailed} />
                    <ConversationActions peerName={peer.name} connected={peerConnected} onReconnect={() => reconnectToPeer(peer)} onDetails={() => { setSelectedPeerId(peer.id); setMobileDrawerOpen(false); setDetailsOpen(true); }} onDelete={() => setDeleteTarget(peer)} />
                  </div>
                </div>
              </li>;
            })}
          </ul>
        </aside>
      </div>

      <PairingModal open={pairingOpen} mode={pairingMode} reconnectPeerName={reconnectingPeer?.name ?? (connectedPeer && reconnectPeerId === connectedPeer.id ? connectedPeer.name : undefined)} busyAction={busyAction} invitationCreated={invitationCreated} invitationOutput={invitationOutput} responseInput={responseInput} joinInput={joinInput} responseOutput={responseOutput} clipboardFallback={clipboardFallback} clipboardFallbackText={clipboardFallbackText}
        onClose={() => setPairingOpen(false)} onMode={(mode) => { setPairingMode(mode); setClipboardFallback(null); setClipboardFallbackText(""); }} onResponseInput={setResponseInput} onJoinInput={setJoinInput}
        onGenerate={() => void withBusy("generate", createAndCopyInvitation)}
        onReadInvitation={() => void withBusy("read-invitation", readAndAcceptInvitation)}
        onAcceptManual={() => void withBusy("accept", () => acceptInvitationText(joinInput || clipboardFallbackText))}
        onReadResponse={() => void withBusy("read-response", readAndCompletePairing)}
        onCompleteManual={() => void withBusy("complete", () => completeWithResponse(responseInput || clipboardFallbackText))}
        onCopyFallback={() => void writeClipboard(clipboardFallbackText, clipboardFallback === "invitation-copy" ? "Invitation" : "Response", clipboardFallback === "invitation-copy" ? "invitation-copy" : "response-copy").then((copied) => { if (!copied) return; if (clipboardFallback === "invitation-copy") setInvitationOutput(""); else setResponseOutput(""); })} />

      <DetailsModal open={detailsOpen} connection={connectionDescription(isConnectedToSelection ? "connected" : reconnectPeerId === selectedPeerId ? connectionState : "disconnected")} peer={selectedPeer?.name ?? connectedPeer?.name ?? "—"} connected={isConnectedToSelection} onClose={() => setDetailsOpen(false)} onDisconnect={() => { messaging.closeConnection(); setDetailsOpen(false); showToast("Connection closed. History and pending messages remain on this device."); }} />
      <DeleteConversationModal peer={deleteTarget} pendingCount={deleteTarget ? outbox.filter((message) => message.toPeerId === deleteTarget.id).length : 0} busy={busyAction === (deleteTarget ? `delete:${deleteTarget.id}` : "")} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDeleteConversation()} />
      <NameSetupModal open={nameSetupOpen} value={displayNameDraft} saving={nameSaving} onChange={setDisplayNameDraft} onSubmit={(event) => void saveDisplayName(event)} />

      <div class="toast toast-end toast-bottom z-[60] w-[min(22rem,calc(100vw-2rem))] pointer-events-none [&>.alert]:pointer-events-auto" aria-live="polite" aria-atomic="true">
        {notices.map((notice) => <div class={`alert ${notice.kind === "error" ? "alert-error" : "alert-info"}`} key={notice.id}><span>{notice.message}</span></div>)}
      </div>
    </div>
  );
}

function Welcome({ onCreate, onJoin }: { onCreate(): void; onJoin(): void }) {
  const steps = [
    { number: "01", icon: "⌁", title: "Pair manually", description: "Exchange a small connection note with someone you know." },
    { number: "02", icon: "↔", title: "Connect directly", description: "Your browsers talk to each other over a WebRTC data channel." },
    { number: "03", icon: "⌁", title: "Keep the thread", description: "Conversation history and pending messages are saved locally." },
  ];
  return <section class="welcome-panel">
    <div class="welcome-eyebrow"><span class="eyebrow-line" /> NO ACCOUNTS. NO CHAT SERVER.</div>
    <h2>Good conversations<br />take the <em>direct route.</em></h2>
    <p class="welcome-copy">Pair two browsers, make a direct connection, and talk. Your messages stay in this browser until they can be delivered to the other side.</p>
    <div class="welcome-actions"><button class="btn btn-primary" type="button" onClick={onCreate}>Start a conversation ↗</button><button class="btn btn-outline" type="button" onClick={onJoin}>Join with invitation</button></div>
    <div class="steps-grid">{steps.map((step) => <article class="card bg-base-100 border border-base-300 shadow-none step-card" key={step.number}><div class="card-body"><span class="badge badge-ghost step-number">{step.number}</span><div class="step-icon">{step.icon}</div><h3 class="card-title">{step.title}</h3><p>{step.description}</p></div></article>)}</div>
    <div class="footnote-row"><span>✓ No signup or account</span><span>✓ Local message history</span><span>✓ Open-source experiment</span></div>
  </section>;
}

function peerConnectionLabel(connected: boolean, state: string): string {
  if (connected) return "Connected";
  if (state === "connecting") return "Connecting";
  if (state === "failed") return "Connection failed";
  return "Disconnected";
}

function ConnectionDot({ peer, connected, connecting, failed }: { peer: PeerRecord; connected: boolean; connecting: boolean; failed: boolean }) {
  const label = connected ? "Connected" : connecting ? "Connecting" : failed ? "Connection failed" : "Disconnected";
  const color = connected ? "status-success" : connecting ? "status-warning" : failed ? "status-error" : "status-neutral";
  return <span class="tooltip tooltip-left conversation-status" data-tip={label} tabIndex={0} aria-label={`${peer.name}: ${label}`} title={`${peer.name}: ${label}`}><span class={`status status-sm ${color}`} aria-hidden="true" /></span>;
}

function ConversationActions({ peerName, connected, onReconnect, onDetails, onDelete }: { peerName: string; connected: boolean; onReconnect(): void; onDetails(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 208;
    setPosition({ top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 170)), left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const action = (callback: () => void) => { setOpen(false); callback(); };
  return <>
    <button ref={triggerRef} type="button" class="btn btn-ghost btn-xs btn-square h-7 min-h-7 w-7 conversation-menu-trigger" aria-label={`Actions for ${peerName}`} aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}><span aria-hidden="true">···</span></button>
    {open && createPortal(<div ref={menuRef} class="fixed z-[100]" style={{ top: `${position.top}px`, left: `${position.left}px`, width: "13rem" }}>
      <ul class="menu conversation-actions-menu rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl" role="menu" aria-label={`${peerName} conversation actions`} onKeyDown={(event) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = items.indexOf(event.target as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (event.key === "Home") { event.preventDefault(); items[0]?.focus(); }
        else if (event.key === "End") { event.preventDefault(); items.at(-1)?.focus(); }
      }}>
        <li><button type="button" role="menuitem" class="conversation-action-item" disabled={connected} onClick={() => action(onReconnect)}><span aria-hidden="true">↻</span>{connected ? "Already connected" : "Reconnect"}</button></li>
        <li><button type="button" role="menuitem" class="conversation-action-item" onClick={() => action(onDetails)}><span aria-hidden="true">ⓘ</span>Connection details</button></li>
        <li><button type="button" role="menuitem" class="conversation-action-item" onClick={() => action(onDelete)}><span aria-hidden="true">⌫</span>Delete conversation</button></li>
      </ul>
    </div>, document.body)}
  </>;
}

function NameSetupModal({ open, value, saving, onChange, onSubmit }: { open: boolean; value: string; saving: boolean; onChange(value: string): void; onSubmit(event: SubmitEvent): void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={dialogRef} class="modal" aria-labelledby="name-setup-title" aria-describedby="name-setup-description" onCancel={(event) => event.preventDefault()}>
    <div class="modal-box max-w-md">
      <div class="dialog-eyebrow">WELCOME TO PAIRWIRE</div>
      <h2 id="name-setup-title" class="mt-3 text-2xl font-semibold tracking-tight">What should we call you?</h2>
      <p id="name-setup-description" class="mt-2 text-sm leading-relaxed text-base-content/65">Choose the name other people will see when you connect. We'll remember it on this device.</p>
      <form class="mt-5 space-y-4" onSubmit={(event) => onSubmit(event as unknown as SubmitEvent)}>
        <fieldset class="fieldset">
          <label class="label" htmlFor="display-name-setup">Your display name</label>
          <input id="display-name-setup" class="input input-bordered w-full" name="display-name" value={value} maxLength={48} minLength={1} required autoComplete="nickname" autoFocus placeholder="Your name" onInput={(event) => onChange((event.currentTarget as HTMLInputElement).value)} />
        </fieldset>
        <div class="rounded-xl bg-base-200/70 p-3">
          <div class="mb-2 text-[.62rem] font-semibold tracking-widest text-base-content/50">PREVIEW</div>
          <div class="flex items-center gap-3"><div class="avatar placeholder"><div class="w-10 rounded-xl border border-success/10 bg-success/10 text-sm font-semibold text-success"><span>{initials(value || "?")}</span></div></div><strong class="text-sm">{value.trim() || "Your name"}</strong></div>
        </div>
        <div class="modal-action mt-2"><button class="btn btn-primary w-full" type="submit" disabled={saving || !value.trim()}>{saving ? <span class="loading loading-spinner loading-xs" /> : "Continue"}</button></div>
      </form>
    </div>
  </dialog>;
}

function DeleteConversationModal({ peer, pendingCount, busy, onCancel, onConfirm }: { peer: PeerRecord | null; pendingCount: number; busy: boolean; onCancel(): void; onConfirm(): void }) {
  if (!peer) return null;
  return <div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title"><div class="modal-box max-w-md">
    <h2 id="delete-conversation-title" class="text-lg font-bold">Delete conversation with {peer.name}?</h2>
    <p class="mt-2 text-sm text-base-content/65">This permanently deletes the conversation history and peer details stored in this browser. It cannot be undone. The other person's copy is not affected.</p>
    {pendingCount > 0 && <div class="alert alert-warning mt-4 text-xs">{pendingCount} queued {pendingCount === 1 ? "message" : "messages"} will also be deleted and cannot be delivered later.</div>}
    <div class="modal-action"><button type="button" class="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" class="btn btn-error" disabled={busy} onClick={onConfirm}>{busy ? <span class="loading loading-spinner loading-xs" /> : "Delete conversation"}</button></div>
  </div><button type="button" class="modal-backdrop" aria-label="Close delete confirmation" onClick={onCancel} /></div>;
}

function Message({ message, peerName, onRetry, retryBusy }: { message: ChatMessage; peerName: string; onRetry(): void; retryBusy: boolean }) {
  const outgoing = message.direction === "outgoing";
  return <div class={`chat ${outgoing ? "chat-end" : "chat-start"}`}>
    <div class="chat-image avatar placeholder message-avatar"><div><span>{outgoing ? "Y" : initials(peerName)}</span></div></div>
    <div class="chat-header">{outgoing ? "You" : peerName}<time dateTime={new Date(message.createdAt).toISOString()}>{prettyTime(message.createdAt)}</time></div>
    <div class={`chat-bubble ${outgoing ? "chat-bubble-primary" : ""}`}>{message.text}</div>
    {outgoing && <div class="chat-footer mt-1"><span class={`badge badge-xs ${message.status === "failed" ? "badge-error" : message.status === "delivered" ? "badge-success" : "badge-ghost"}`}>{statusLabel(message.status)}</span>{message.status === "failed" && <button class="btn btn-ghost btn-xs" type="button" disabled={retryBusy} onClick={onRetry}>Retry</button>}</div>}
  </div>;
}

function PairingModal(props: {
  open: boolean; mode: PairingMode; reconnectPeerName: string | undefined; busyAction: string | null;
  invitationCreated: boolean; invitationOutput: string; responseInput: string; joinInput: string; responseOutput: string;
  clipboardFallback: "join" | "response" | "invitation-copy" | "response-copy" | null; clipboardFallbackText: string;
  onClose(): void; onMode(mode: PairingMode): void; onResponseInput(value: string): void; onJoinInput(value: string): void;
  onGenerate(): void; onReadInvitation(): void; onAcceptManual(): void; onReadResponse(): void; onCompleteManual(): void; onCopyFallback(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  const busy = Boolean(props.busyAction);
  return <dialog ref={dialogRef} class="modal" onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div class="modal-box w-[min(32rem,calc(100vw-1.75rem))] max-w-none max-h-[88dvh] overflow-y-auto p-0">
      <div class="flex items-start justify-between gap-4 px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-5"><div><div class="dialog-eyebrow mb-2">{props.reconnectPeerName ? "RECONNECT A KNOWN PEER" : "MAKE A CONNECTION"}</div><h2 class="text-xl font-bold tracking-tight">{props.reconnectPeerName ? `Reconnect to ${props.reconnectPeerName}` : "Connect directly."}</h2><p class="mt-2 max-w-md text-xs leading-relaxed text-base-content/60">Exchange a short invitation through a messaging app you already use. Pairwire never sends your chat through a messaging server.</p></div><button class="btn btn-ghost btn-sm btn-square" type="button" onClick={props.onClose} aria-label="Close pairing dialog">✕</button></div>
      <div role="tablist" class="tabs tabs-box mx-6 max-sm:mx-4"><button role="tab" type="button" class={`tab ${props.mode === "create" ? "tab-active" : ""}`} aria-selected={props.mode === "create"} onClick={() => props.onMode("create")}>Start a connection</button><button role="tab" type="button" class={`tab ${props.mode === "join" ? "tab-active" : ""}`} aria-selected={props.mode === "join"} onClick={() => props.onMode("join")}>Join a connection</button></div>
      {props.mode === "create" ? <section class="space-y-4 px-6 pt-5 max-sm:px-4 max-sm:pt-4" role="tabpanel">
        <div class="rounded-box border border-base-300 p-4"><div class="mb-1 text-sm font-semibold">1. Create your invitation</div><p class="mb-3 text-xs leading-relaxed text-base-content/60">We'll create the connection note and copy it automatically. Send it to the other person.</p><button class="btn btn-primary w-full" type="button" disabled={busy} onClick={props.onGenerate}>{props.busyAction === "generate" ? <span class="loading loading-spinner loading-xs" /> : "Create & copy invitation ↗"}</button>
          {props.invitationOutput && <div class="mt-3 space-y-2"><div class="alert alert-warning text-xs">Clipboard copy wasn't available. Copy this invitation manually.</div><textarea class="textarea textarea-bordered w-full font-mono text-xs" rows={4} readOnly value={props.invitationOutput} /><button class="btn btn-outline btn-sm" type="button" onClick={props.onCopyFallback}>Try copying again</button></div>}
        </div>
        <div class="rounded-box border border-base-300 p-4"><div class="mb-1 text-sm font-semibold">2. Read their response</div><p class="mb-3 text-xs leading-relaxed text-base-content/60">When they reply, read the response from your clipboard to finish pairing.</p><button class="btn btn-outline w-full" type="button" disabled={!props.invitationCreated || busy} onClick={props.onReadResponse}>{props.busyAction === "read-response" || props.busyAction === "complete" ? <span class="loading loading-spinner loading-xs" /> : "Read response from clipboard"}</button>
          {(props.clipboardFallback === "response" || props.responseInput) && <div class="mt-3 space-y-2"><div class="alert alert-info text-xs">Paste the response here if clipboard reading isn't available.</div><textarea class="textarea textarea-bordered w-full font-mono text-xs" rows={3} placeholder="Paste the response text…" value={props.responseInput || props.clipboardFallbackText} onInput={(event) => props.onResponseInput((event.currentTarget as HTMLTextAreaElement).value)} /><button class="btn btn-primary w-full" type="button" disabled={busy || !(props.responseInput || props.clipboardFallbackText).trim()} onClick={props.onCompleteManual}>Complete pairing</button></div>}
        </div>
      </section> : <section class="space-y-4 px-6 pt-5 max-sm:px-4 max-sm:pt-4" role="tabpanel">
        <div class="rounded-box border border-base-300 p-4"><div class="mb-1 text-sm font-semibold">1. Read their invitation</div><p class="mb-3 text-xs leading-relaxed text-base-content/60">Ask the other person to create an invitation, then copy it. Pairwire will check that it is valid before accepting it.</p><button class="btn btn-primary w-full" type="button" disabled={busy || Boolean(props.responseOutput)} onClick={props.onReadInvitation}>{props.busyAction === "read-invitation" || props.busyAction === "accept" ? <span class="loading loading-spinner loading-xs" /> : "Read invitation from clipboard"}</button>
          {(props.clipboardFallback === "join" || props.joinInput) && <div class="mt-3 space-y-2"><div class="alert alert-info text-xs">Paste the invitation here if clipboard reading isn't available.</div><textarea class="textarea textarea-bordered w-full font-mono text-xs" rows={4} placeholder="Paste the invitation text…" value={props.joinInput || props.clipboardFallbackText} onInput={(event) => props.onJoinInput((event.currentTarget as HTMLTextAreaElement).value)} /><button class="btn btn-outline w-full" type="button" disabled={busy || !(props.joinInput || props.clipboardFallbackText).trim()} onClick={props.onAcceptManual}>Use invitation</button></div>}
        </div>
        {props.responseOutput && <div class="rounded-box border border-base-300 p-4"><div class="mb-1 text-sm font-semibold">2. Send your response</div><p class="mb-3 text-xs text-base-content/60">Your response couldn't be copied automatically. Copy it manually and send it to the inviter.</p><textarea class="textarea textarea-bordered w-full font-mono text-xs" rows={4} readOnly value={props.responseOutput} /><button class="btn btn-outline btn-sm mt-2" type="button" onClick={props.onCopyFallback}>Try copying again</button></div>}
      </section>}
      <div class="alert alert-info mx-6 my-5 text-xs max-sm:mx-4"><span>Only exchange invitations with people you intend to connect with. They contain temporary connection details.</span></div>
    </div>
    <form method="dialog" class="modal-backdrop"><button type="button" onClick={props.onClose}>close</button></form>
  </dialog>;
}

function Step({ number, title, description }: { number: string; title: string; description: string }) {
  return <div class="mb-3 flex items-start gap-3"><span class="badge badge-outline h-6 w-6 shrink-0">{number}</span><div><h3>{title}</h3><p>{description}</p></div></div>;
}

function DetailsModal({ open, connection, peer, connected, onClose, onDisconnect }: { open: boolean; connection: string; peer: string; connected: boolean; onClose(): void; onDisconnect(): void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={dialogRef} class="modal" onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div class="modal-box w-[min(25rem,calc(100vw-1.75rem))] max-w-none p-0 pb-5"><div class="flex items-start justify-between gap-4 px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-5"><div><div class="dialog-eyebrow mb-2">CONNECTION</div><h2 class="text-xl font-bold tracking-tight">Connection details</h2></div><button class="btn btn-ghost btn-sm btn-square" type="button" onClick={onClose} aria-label="Close connection details">✕</button></div>
      <div class="mx-6 mb-4 overflow-hidden rounded-lg border border-base-300 max-sm:mx-4">
        <table class="table table-sm"><tbody>
          <tr><th class="font-normal text-base-content/60">Status</th><td class="text-right font-semibold">{connection}</td></tr>
          <tr><th class="font-normal text-base-content/60">Peer</th><td class="text-right font-semibold">{peer}</td></tr>
          <tr><th class="font-normal text-base-content/60">Transport</th><td class="text-right font-semibold">WebRTC data channel</td></tr>
          <tr><th class="font-normal text-base-content/60">Message storage</th><td class="text-right font-semibold">This browser</td></tr>
        </tbody></table>
      </div>
      <div class="mx-6 flex flex-wrap gap-2 max-sm:mx-4">{connected && <button class="btn btn-error btn-outline flex-1" type="button" onClick={onDisconnect}>Disconnect</button>}</div><p class="mx-6 mt-3 text-xs leading-relaxed text-base-content/60 max-sm:mx-4">Disconnecting does not delete conversation history or queued messages. Reconnect using the same peer identity to continue this thread.</p>
    </div><form method="dialog" class="modal-backdrop"><button type="button" onClick={onClose}>close</button></form>
  </dialog>;
}

render(<App />, document.getElementById("app")!);
