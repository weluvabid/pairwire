import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import "./styles.css";
import { MessagingService } from "./core/messaging-service.js";
import type { ChatMessage, PeerIdentity, PeerRecord } from "./core/types.js";
import { conversationIdFor, MAX_TEXT_LENGTH } from "./core/types.js";
import { decodeAnySignaling, decodeSignaling } from "./core/protocol.js";
import { writeClipboardText } from "./services/clipboard.js";
import { connectionDescription, countPendingByPeer, initials, peerConnectionLabel } from "./utils/formatting.js";
import { useMessagingRevision, emitMessagingChange } from "./hooks/useMessagingRevision.js";
import { useTextareaAutosize } from "./hooks/useTextareaAutosize.js";
import { ConnectionDot } from "./components/conversations/ConnectionDot.js";
import { ConversationActions } from "./components/conversations/ConversationActions.js";
import { DeleteConversationModal } from "./components/dialogs/DeleteConversationModal.js";
import { DetailsModal } from "./components/dialogs/DetailsModal.js";
import { Message } from "./components/chat/Message.js";
import { NameSetupModal } from "./components/pairing/NameSetupModal.js";
import { PairingModal, type PairingPhase, type PastedSignalingType } from "./components/pairing/PairingModal.js";
import { Welcome } from "./components/layout/Welcome.js";
import { PairwireStore } from "./storage/indexed-db.js";

type Notice = { id: number; message: string; kind: "info" | "error" };
const store = new PairwireStore();
const messaging = new MessagingService(store, {
  onChange: emitMessagingChange,
  onNotice: (message, kind = "info") => window.dispatchEvent(new CustomEvent("pairwire:notice", { detail: { message, kind } })),
});

function App() {
  const revision = useMessagingRevision();
  const [localPeer, setLocalPeer] = useState<PeerIdentity | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
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
  const [reconnectPeerId, setReconnectPeerId] = useState<string | null>(null);
  const [invitationOutput, setInvitationOutput] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [pastedType, setPastedType] = useState<PastedSignalingType>(null);
  const [pastedError, setPastedError] = useState<string | null>(null);
  const [responseOutput, setResponseOutput] = useState("");
  const [pairingPhase, setPairingPhase] = useState<PairingPhase>(null);
  const [clipboardFallback, setClipboardFallback] = useState<"invitation-copy" | "response-copy" | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [historyScrolled, setHistoryScrolled] = useState(false);
  const [messageAnnouncement, setMessageAnnouncement] = useState("");
  const historyRef = useRef<HTMLDivElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastRenderedConversation = useRef<string | null>(null);
  const announcedConversation = useRef<string | null>(null);
  const announcedMessage = useRef<string | null>(null);
  const previousScroll = useRef({ height: 0, top: 0, nearBottom: true });
  const toastId = useRef(0);
  const connectedPeer = messaging.connectedPeer;
  const connectionState = messaging.connectionState;

  const showToast = useCallback((message: string, kind: "info" | "error" = "info") => {
    const id = ++toastId.current;
    setNotices((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 4500);
  }, []);

  useEffect(() => {
    if (connectionState !== "connected" || !connectedPeer || !pairingPhase) return;
    setPairingPhase(null);
    setPairingOpen(false);
    setReconnectPeerId(null);
  }, [pairingPhase, connectionState, connectedPeer?.id]);


  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; kind?: "info" | "error" }>).detail;
      showToast(detail.message, detail.kind ?? "info");
    };
    window.addEventListener("pairwire:notice", onNotice);
    return () => window.removeEventListener("pairwire:notice", onNotice);
  }, [showToast]);

  useEffect(() => {
    const onMessage = (event: Event) => {
      const message = (event as CustomEvent<ChatMessage>).detail;
      if (!localPeer || !selectedPeerId) return;
      const conversationId = conversationIdFor(localPeer.id, selectedPeerId);
      if (message.conversationId !== conversationId) return;

      const history = historyRef.current;
      const oldHeight = history?.scrollHeight ?? 0;
      const oldTop = history?.scrollTop ?? 0;
      const nearBottom = !history || oldHeight - oldTop - history.clientHeight < 88;
      previousScroll.current = { height: oldHeight, top: oldTop, nearBottom };

      setMessages((current) => {
        const index = current.findIndex((item) => item.id === message.id);
        if (index === -1) return [...current, message].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        const next = current.slice();
        next[index] = message;
        return next;
      });
    };
    window.addEventListener("pairwire:message", onMessage);
    return () => window.removeEventListener("pairwire:message", onMessage);
  }, [localPeer?.id, selectedPeerId]);


  useEffect(() => {
    if (!("RTCPeerConnection" in window)) {
      setStartupError("This browser does not support WebRTC data channels.");
      return;
    }
    if (!("indexedDB" in window)) {
      setStartupError("This browser does not support local message storage.");
      return;
    }
    let cancelled = false;
    setInitialized(false);
    setStartupError(null);
    void (async () => {
      const identity = await messaging.initialize();
      const [storedName, storedPeers, storedConversations, storedOutbox] = await Promise.all([
        messaging.getStoredDisplayName(),
        messaging.getPeers(),
        messaging.getConversations(),
        messaging.getOutbox(),
      ]);
      if (cancelled) return;
      setLocalPeer(identity);
      setPeers(storedPeers);
      setConversations(storedConversations);
      setOutbox(storedOutbox);
      setSelectedPeerId(storedPeers[0]?.id ?? null);
      if (!storedName) setNameSetupOpen(true);
      setInitialized(true);
    })().catch((error: unknown) => {
      if (cancelled) return;
      setInitialized(false);
      setStartupError(error instanceof Error ? error.message : "Pairwire could not start.");
    });
    return () => { cancelled = true; };
  }, [startupAttempt]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const sidebar = sidebarRef.current;
    const focusable = () => {
      const selector = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';
      const sidebarItems = Array.from(sidebar?.querySelectorAll<HTMLElement>(selector) ?? []);
      const menuItems = Array.from(document.querySelectorAll<HTMLElement>(`.conversation-actions-menu ${selector}`));
      return [...sidebarItems, ...menuItems].filter((element) => element.getAttribute("aria-hidden") !== "true");
    };
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileDrawerOpen(false);
        drawerTriggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeIsInsideDrawer = Boolean(sidebar?.contains(document.activeElement)
        || document.querySelector(".conversation-actions-menu")?.contains(document.activeElement));
      if (event.shiftKey && (document.activeElement === first || !activeIsInsideDrawer)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !activeIsInsideDrawer)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileDrawerOpen]);

  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (mobileDrawerOpen) drawerWasOpen.current = true;
    else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      drawerTriggerRef.current?.focus();
    }
  }, [mobileDrawerOpen]);

  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    void Promise.all([messaging.getPeers(), messaging.getConversations(), messaging.getOutbox()]).then(([nextPeers, nextConversations, nextOutbox]) => {
      if (cancelled) return;
      setPeers(nextPeers);
      setConversations(nextConversations);
      setOutbox(nextOutbox);
      // Refreshing message/peer data must not override an intentional
      // conversation selection just because another peer is connected.
      if (selectedPeerId && !nextPeers.some((peer) => peer.id === selectedPeerId)) setSelectedPeerId(nextPeers[0]?.id ?? null);
      else if (!selectedPeerId && nextPeers.length) setSelectedPeerId(nextPeers[0]!.id);
    }).catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not load conversations.", "error"));
    return () => { cancelled = true; };
  }, [initialized, revision, selectedPeerId, showToast]);

  // A newly established/replaced connection should open its conversation once.
  // Subsequent message revisions must not steal selection from the user.
  useEffect(() => {
    if (connectionState === "connected" && connectedPeer) setSelectedPeerId(connectedPeer.id);
  }, [connectionState, connectedPeer?.id]);

  const selectedPeer = useMemo(() => {
    const stored = peers.find((peer) => peer.id === selectedPeerId);
    if (stored) return stored;
    if (connectedPeer && connectedPeer.id === selectedPeerId && localPeer) {
      return { ...connectedPeer, lastSeenAt: 0, conversationId: conversationIdFor(localPeer.id, connectedPeer.id) } satisfies PeerRecord;
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
    previousMessageCount.current = -1;
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
  }, [selectedPeer?.id, localPeer?.id, showToast]);

  const previousMessageCount = useRef(0);
  useEffect(() => {
    if (messages.length === previousMessageCount.current) return;
    previousMessageCount.current = messages.length;
    const history = historyRef.current;
    if (!history) return;
    const { height, top, nearBottom } = previousScroll.current;
    if (nearBottom) history.scrollTop = history.scrollHeight;
    else history.scrollTop = top + (history.scrollHeight - height);
  }, [messages.length]);

  useEffect(() => {
    if (!selectedPeer || !localPeer) return;
    const conversationId = conversationIdFor(localPeer.id, selectedPeer.id);
    if (lastRenderedConversation.current !== conversationId) return;
    const latestIncoming = [...messages].reverse().find((message) => message.direction === "incoming");
    if (announcedConversation.current !== conversationId) {
      announcedConversation.current = conversationId;
      announcedMessage.current = latestIncoming?.id ?? null;
      setMessageAnnouncement("");
      return;
    }
    if (latestIncoming && latestIncoming.id !== announcedMessage.current) {
      announcedMessage.current = latestIncoming.id;
      setMessageAnnouncement(`New message from ${selectedPeer.name}: ${latestIncoming.text}`);
    }
  }, [messages, selectedPeer?.id, selectedPeer?.name, localPeer?.id]);

  useTextareaAutosize(messageInputRef, draft);

  const isConnectedToSelection = connectionState === "connected" && connectedPeer?.id === selectedPeerId;
  const pendingCountsByPeer = useMemo(() => countPendingByPeer(outbox), [outbox]);
  const conversationsById = useMemo(() => new Map(conversations.map((conversation) => [conversation.id, conversation])), [conversations]);
  const pendingForSelection = selectedPeerId ? pendingCountsByPeer.get(selectedPeerId) ?? 0 : 0;
  const reconnectingPeer = reconnectPeerId ? peers.find((peer) => peer.id === reconnectPeerId) : undefined;
  const composerHint = isConnectedToSelection
    ? "Messages save locally first. Delivered means the other browser confirmed persistence."
    : connectedPeer && connectedPeer.id !== selectedPeerId
      ? `Reconnect to ${selectedPeer?.name ?? "this peer"} to send a message.`
      : "Your history stays on this device. Connect to this peer to send a message.";
  const pairingNotice = pairingPhase === "response-created" && connectedPeer?.id === selectedPeerId
    ? `Your response is ready. Send it back to ${connectedPeer.name}; the connection will finish when they complete pairing.`
    : pairingPhase === "connecting" && (connectedPeer?.id === selectedPeerId || reconnectPeerId === selectedPeerId)
      ? `Connecting to ${selectedPeer?.name ?? "your peer"}… Keep Pairwire open while the connection is established.`
      : pairingPhase === "invitation-created" && reconnectPeerId === selectedPeerId
        ? `Your new invitation is ready. Send it to ${selectedPeer?.name ?? "your peer"} to reconnect.`
        : null;

  const withBusy = async (key: string, action: () => Promise<void>) => {
    if (busyActionRef.current) return;
    busyActionRef.current = key;
    setBusyAction(key);
    try { await action(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Something went wrong.", "error"); }
    finally { busyActionRef.current = null; setBusyAction(null); }
  };

  const openPairing = () => {
    if (!initialized || !localPeer || nameSetupOpen) return;
    const selectedIsDisconnected = Boolean(selectedPeerId && peers.some((peer) => peer.id === selectedPeerId) && !(connectionState === "connected" && connectedPeer?.id === selectedPeerId));
    setReconnectPeerId(selectedIsDisconnected ? selectedPeerId : null);
    setInvitationOutput("");
    setPastedText("");
    setPastedType(null);
    setPastedError(null);
    setResponseOutput("");
    setPairingPhase(null);
    setClipboardFallback(null);
    setPairingOpen(true);
  };

  const reconnectToPeer = (peer: PeerRecord) => {
    if (!initialized || !localPeer || nameSetupOpen) return;
    if (connectedPeer && connectedPeer.id !== peer.id) {
      showToast(`Pairwire supports one active connection. Reconnecting to ${peer.name} will close the connection to ${connectedPeer.name}.`);
    }
    setSelectedPeerId(peer.id);
    setReconnectPeerId(peer.id);
    setInvitationOutput("");
    setPastedText("");
    setPastedType(null);
    setPastedError(null);
    setResponseOutput("");
    setPairingPhase(null);
    setClipboardFallback(null);
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
      await writeClipboardText(value);
      setClipboardFallback(null);
        showToast(successMessage ?? `${label} copied. Share it with your peer.`);
      return true;
    } catch (error) {
      setClipboardFallback(fallback);
      // The inline manual-copy fallback is the actionable feedback. Avoid a
      // duplicate permission-denied toast that obscures the pairing dialog.
      return false;
    }
  };

  const acceptInvitationText = async (value: string) => {
    decodeSignaling(value, "pairwire-invitation");
    const response = await messaging.acceptInvitation(value, reconnectPeerId ?? undefined);
    await writeClipboard(response, "Response", "response-copy");
    setResponseOutput(response);
    setPairingPhase("response-created");
    setPastedText("");
    setPastedType(null);
    setPastedError(null);
  };

  const completeWithResponse = async (value: string) => {
    decodeSignaling(value, "pairwire-response");
    await messaging.completePairing(value, reconnectPeerId ?? undefined);
    setPastedText("");
    setPastedType(null);
    setPastedError(null);
    setClipboardFallback(null);
    setPairingPhase("connecting");
    showToast("Response accepted. Establishing the direct connection…");
  };

  const createAndCopyInvitation = async () => {
    // Each invitation owns a fresh RTCPeerConnection. Creating another one
    // intentionally replaces the previous pending invitation.
    setInvitationOutput("");
    const value = await messaging.createInvitation();
    await writeClipboard(
      value,
      "Invitation",
      "invitation-copy",
      "New invitation copied. It replaces any earlier invitation; share this one with your peer.",
    );
    setInvitationOutput(value);
    setPairingPhase("invitation-created");
  };

  const handlePastedSignaling = (value: string) => {
    setPastedText(value);
    if (!value.trim()) {
      setPastedType(null);
      setPastedError(null);
      return;
    }
    try {
      const payload = decodeAnySignaling(value);
      setPastedType(payload.type === "pairwire-invitation" ? "invitation" : "response");
      setPastedError(null);
    } catch (error) {
      setPastedType(null);
      setPastedError(error instanceof Error ? error.message : "This doesn't look like a Pairwire invitation or response.");
    }
  };

  const createNewInvitation = async () => {
    setReconnectPeerId(null);
    await createAndCopyInvitation();
  };

  const reconnectWithInvitation = async () => {
    if (!reconnectPeerId) return;
    await createAndCopyInvitation();
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
          {!initialized ? startupError
            ? <div class="flex flex-1 items-center justify-center p-6"><div class="alert alert-error max-w-lg" role="alert"><div class="flex flex-col gap-3"><span>{startupError}</span><button class="btn btn-sm" type="button" onClick={() => setStartupAttempt((attempt) => attempt + 1)}>Retry startup</button></div></div></div>
            : <div class="flex flex-1 flex-col items-center justify-center gap-3" role="status" aria-live="polite"><span class="loading loading-spinner loading-md text-base-content/70" aria-hidden="true" /><span class="text-xs text-base-content/70">Preparing your conversations…</span></div>
            : <>
          <div class="mobile-context lg:hidden">
            <button ref={drawerTriggerRef} type="button" class="btn btn-ghost btn-square btn-sm" aria-label="Open conversations" aria-expanded={mobileDrawerOpen} aria-controls="pairwire-sidebar" onClick={() => setMobileDrawerOpen(true)}>☰</button>
            {selectedPeer && <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold">{selectedPeer.name}</div>
              <div class="flex items-center gap-2 text-xs text-base-content/70"><ConnectionDot peer={selectedPeer} connected={isConnectedToSelection} connecting={reconnectPeerId === selectedPeer.id && connectionState === "connecting"} failed={reconnectPeerId === selectedPeer.id && connectionState === "failed"} /><span>{peerConnectionLabel(isConnectedToSelection, reconnectPeerId === selectedPeer.id ? connectionState : "disconnected")}</span></div>
            </div>}
          </div>

          {!selectedPeer ? (
            <div class="welcome-scroll">
              <Welcome onCreate={openPairing} />
              <footer class="main-footer"><span><span class="footer-led" /> A small experiment in direct communication</span><span>Pairwire <span class="footer-divider">/</span> v0.1.0</span></footer>
            </div>
          ) : (
            <section class="chat-panel" aria-label="Conversation">
              {(!isConnectedToSelection || pendingForSelection > 0) && <div class={`chat-notices ${historyScrolled ? "is-scrolled" : ""}`}>
                {!isConnectedToSelection && <div class={`alert ${pairingNotice ? "alert-info" : "alert-warning"} mx-auto max-w-xl text-xs`} role="status" aria-live="polite"><span>{pairingNotice ?? `${selectedPeer.name} is disconnected. Your local history is safe; reconnect to continue this conversation.`}</span></div>}
                {pendingForSelection > 0 && <div class="alert alert-info mx-auto max-w-xl text-xs" role="status" aria-live="polite"><span>{pendingForSelection} {pendingForSelection === 1 ? "message is" : "messages are"} waiting for delivery. They will be retried when you reconnect.</span></div>}
              </div>}
              <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{messageAnnouncement}</div>
              <div class="chat-history" ref={historyRef} onScroll={(event) => setHistoryScrolled((event.currentTarget as HTMLDivElement).scrollTop > 0)} role="region" aria-label="Message history" tabIndex={0}>
                <div class="history-start"><span /><p>{messages.length ? "Conversation history" : "This is the beginning of your conversation."}</p><span /></div>
                {messages.map((message) => <Message key={message.id} message={message} peerName={connectedPeer?.name ?? selectedPeer.name} onRetry={() => void withBusy(`retry:${message.id}`, () => messaging.retryMessage(message.id))} retryBusy={busyAction === `retry:${message.id}`} />)}
              </div>
              <div class="composer-wrap">
                <div id="composer-hint" class="composer-hint">{composerHint}</div>
                <form class="rounded-xl border border-base-300 bg-base-100 p-3 shadow-sm focus-within:border-success/40 focus-within:shadow-md" onSubmit={(event) => void sendMessage(event as unknown as SubmitEvent)}>
                  <label class="sr-only" htmlFor="message-input">Write a message</label>
                  <textarea ref={messageInputRef} id="message-input" class="textarea textarea-ghost min-h-16 max-h-36 w-full resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-xs leading-relaxed" name="message" aria-describedby="composer-hint composer-count" rows={1} maxLength={MAX_TEXT_LENGTH} placeholder="Write something thoughtful…" value={draft} disabled={!isConnectedToSelection} onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit(); } }} />
                  <div class="flex items-center justify-between border-t border-base-200 pt-2">
                    <span id="composer-count" class="font-mono text-[.62rem] text-base-content/70">{draft.length.toLocaleString()} of {MAX_TEXT_LENGTH.toLocaleString()} characters</span>
                    <button class="btn btn-primary btn-sm" type="submit" disabled={sending || !isConnectedToSelection || !draft.trim()}>{sending ? <span class="loading loading-spinner loading-xs" /> : "Send ↑"}</button>
                  </div>
                </form>
                <div class="mt-2 flex justify-end gap-3 text-[.55rem] text-base-content/75"><span>Enter to send</span><span>Shift + Enter for a new line</span></div>
              </div>
            </section>
          )}
          {selectedPeer && <footer class="main-footer"><span><span class="footer-led" /> A small experiment in direct communication</span><span>Pairwire <span class="footer-divider">/</span> v0.1.0</span></footer>}
          </>}
        </main>
      </div>
      <div class="drawer-side z-40">
        <button type="button" aria-label="Close conversations" class="drawer-overlay" onClick={() => setMobileDrawerOpen(false)} />
        <aside ref={sidebarRef} id="pairwire-sidebar" class="sidebar" aria-label="Conversations" role={mobileDrawerOpen ? "dialog" : "complementary"} aria-modal={mobileDrawerOpen ? "true" : undefined}>
          <div class="sidebar-header">
            <div class="sidebar-topline">
              <div class="sidebar-identity">
                <div class="brand-name">pairwire</div>
                {localPeer && <div class="brand-user" title={`This device is using the name ${localPeer.name}`}>Using as <strong>{localPeer.name}</strong></div>}
              </div>
              <div class="sidebar-topline-actions">
                <a class="sidebar-github" href="https://github.com/weluvabid/pairwire" target="_blank" rel="noopener noreferrer">GitHub</a>
                <button type="button" class="btn btn-ghost btn-square btn-sm lg:hidden" aria-label="Close conversations" onClick={() => setMobileDrawerOpen(false)}>✕</button>
              </div>
            </div>
            <div class="sidebar-actions"><button class="btn btn-primary btn-sm w-full" type="button" disabled={!initialized || !localPeer || nameSetupOpen} onClick={() => { setMobileDrawerOpen(false); openPairing(); }}>＋ New connection</button></div>
            <div class="sidebar-section-heading"><span>CONVERSATIONS</span><span class="badge badge-ghost">{peers.length}</span></div>
          </div>
          <ul class="menu conversation-list">
            {peers.length === 0 ? <li class="menu-disabled"><span>Your people will show up here.</span></li> : [...peers].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((peer) => {
              const preview = conversationsById.get(peer.conversationId)?.lastMessage ?? "Direct conversation";
              const queuedCount = pendingCountsByPeer.get(peer.id) ?? 0;
              const peerConnected = connectionState === "connected" && connectedPeer?.id === peer.id;
              const peerConnecting = reconnectPeerId === peer.id && connectionState === "connecting";
              const peerFailed = reconnectPeerId === peer.id && connectionState === "failed";
              return <li key={peer.id} class={`conversation-entry ${peer.id === selectedPeerId ? "is-selected" : ""}`}>
                <button type="button" class={`conversation-select ${peer.id === selectedPeerId ? "menu-active" : ""}`} aria-current={peer.id === selectedPeerId ? "page" : undefined} onClick={() => { setSelectedPeerId(peer.id); setMobileDrawerOpen(false); }}>
                  <div class="avatar placeholder conversation-avatar"><div><span>{initials(peer.name)}</span></div></div>
                  <span class="conversation-copy"><span class="conversation-name">{peer.name}</span><span class="conversation-preview">{preview}</span></span>
                  {queuedCount > 0 && <span class="badge badge-warning badge-xs" title={`${queuedCount} messages waiting for delivery`}>{queuedCount}</span>}
                </button>
                <div class="conversation-controls">
                  <ConnectionDot peer={peer} connected={peerConnected} connecting={peerConnecting} failed={peerFailed} />
                  <ConversationActions peerName={peer.name} connected={peerConnected} onReconnect={() => reconnectToPeer(peer)} onDetails={() => { setSelectedPeerId(peer.id); setMobileDrawerOpen(false); setDetailsOpen(true); }} onDelete={() => setDeleteTarget(peer)} />
                </div>
              </li>;
            })}
          </ul>
        </aside>
      </div>

      <PairingModal
        open={pairingOpen}
        reconnectPeerName={reconnectingPeer?.name ?? (connectedPeer && reconnectPeerId === connectedPeer.id ? connectedPeer.name : undefined)}
        busyAction={busyAction}
        invitationOutput={invitationOutput}
        responseOutput={responseOutput}
        pairingPhase={pairingPhase}
        pastedText={pastedText}
        pastedType={pastedType}
        pastedError={pastedError}
        clipboardFallback={clipboardFallback}
        onClose={() => setPairingOpen(false)}
        onPasteText={handlePastedSignaling}
        onGenerate={() => void withBusy("generate", createNewInvitation)}
        onReconnect={() => void withBusy("reconnect", reconnectWithInvitation)}
        onAcceptInvitation={() => void withBusy("accept", () => acceptInvitationText(pastedText))}
        onCompleteResponse={() => void withBusy("complete", () => completeWithResponse(pastedText))}
        onCopyInvitation={() => void writeClipboard(invitationOutput, "Invitation", "invitation-copy")}
        onCopyResponse={() => void writeClipboard(responseOutput, "Response", "response-copy")}
      />

      <DetailsModal open={detailsOpen} connection={connectionDescription(isConnectedToSelection ? "connected" : reconnectPeerId === selectedPeerId ? connectionState : "disconnected")} peer={selectedPeer?.name ?? connectedPeer?.name ?? "—"} connected={isConnectedToSelection} onClose={() => setDetailsOpen(false)} onDisconnect={() => { messaging.closeConnection(); setDetailsOpen(false); showToast("Connection closed. History and pending messages remain on this device."); }} />
      <DeleteConversationModal peer={deleteTarget} pendingCount={deleteTarget ? pendingCountsByPeer.get(deleteTarget.id) ?? 0 : 0} busy={busyAction === (deleteTarget ? `delete:${deleteTarget.id}` : "")} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDeleteConversation()} />
      <NameSetupModal open={nameSetupOpen} value={displayNameDraft} saving={nameSaving} onChange={setDisplayNameDraft} onSubmit={(event) => void saveDisplayName(event)} />

      <div class="toast toast-end toast-bottom z-[60] w-[min(22rem,calc(100vw-2rem))] pointer-events-none [&>.alert]:pointer-events-auto" aria-live="polite" aria-atomic="false">
        {notices.map((notice) => <div class={`alert ${notice.kind === "error" ? "alert-error" : "alert-info"}`} key={notice.id}><span>{notice.message}</span></div>)}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
