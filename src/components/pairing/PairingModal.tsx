import { useEffect, useRef } from "preact/hooks";

export type PastedSignalingType = "invitation" | "response" | null;

export function PairingModal(props: {
  open: boolean;
  reconnectPeerName: string | undefined;
  busyAction: string | null;
  invitationOutput: string;
  responseOutput: string;
  pastedText: string;
  pastedType: PastedSignalingType;
  pastedError: string | null;
  clipboardFallback: "invitation-copy" | "response-copy" | null;
  onClose(): void;
  onPasteText(value: string): void;
  onGenerate(): void;
  onReconnect(): void;
  onAcceptInvitation(): void;
  onCompleteResponse(): void;
  onCopyFallback(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  const busy = Boolean(props.busyAction);
  const actionLabel = props.pastedType === "invitation"
    ? "Accept invitation"
    : props.pastedType === "response"
      ? "Complete connection"
      : "Waiting for connection text";

  return <dialog ref={dialogRef} class="modal" onClose={props.onClose} onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div class="modal-box w-[min(34rem,calc(100vw-1.75rem))] max-w-none max-h-[88dvh] overflow-y-auto p-0">
      <div class="flex items-start justify-between gap-4 px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-5">
        <div>
          <div class="dialog-eyebrow mb-2">MAKE A CONNECTION</div>
          <h2 class="text-xl font-bold tracking-tight">Connect directly.</h2>
          <p class="mt-2 max-w-md text-xs leading-relaxed text-base-content/60">Exchange a connection invitation through a messaging app you already use. Pairwire never sends your chat through a messaging server.</p>
        </div>
        <button class="btn btn-ghost btn-sm btn-square" type="button" onClick={props.onClose} aria-label="Close pairing dialog">✕</button>
      </div>

      <section class="space-y-4 px-6 pt-2 max-sm:px-4">
        <div class="rounded-box border border-base-300 p-4 space-y-3">
          <div>
            <div class="text-sm font-semibold">Start a new conversation</div>
            <p class="mt-1 text-xs leading-relaxed text-base-content/60">Create an invitation and share it with someone.</p>
          </div>
          <button class="btn btn-primary w-full" type="button" disabled={busy} onClick={props.onGenerate}>
            {props.busyAction === "generate" ? <span class="loading loading-spinner loading-xs" /> : "Create & copy invitation ↗"}
          </button>
          {props.invitationOutput && <div class="space-y-2">
            <div class="alert alert-warning text-xs">Clipboard copy wasn't available. Copy this invitation manually.</div>
            <textarea class="textarea textarea-bordered w-full resize-none font-mono text-xs" rows={4} readOnly value={props.invitationOutput} />
            <button class="btn btn-outline btn-sm" type="button" onClick={props.onCopyFallback}>Try copying again</button>
          </div>}
        </div>

        {props.reconnectPeerName && <div class="rounded-box border border-base-300 p-4 space-y-3">
          <div>
            <div class="text-sm font-semibold">Reconnect to an existing conversation</div>
            <p class="mt-1 text-xs leading-relaxed text-base-content/60">Continue your conversation with {props.reconnectPeerName} without losing its history.</p>
          </div>
          <button class="btn btn-outline w-full" type="button" disabled={busy} onClick={props.onReconnect}>
            {props.busyAction === "reconnect" ? <span class="loading loading-spinner loading-xs" /> : `Reconnect with ${props.reconnectPeerName}`}
          </button>
        </div>}

        <div class="rounded-box border border-base-300 p-4 space-y-3">
          <div>
            <div class="text-sm font-semibold">Have an invitation or response?</div>
            <p class="mt-1 text-xs leading-relaxed text-base-content/60">Paste the text you received. Pairwire will recognise it automatically.</p>
          </div>
          <textarea
            class="textarea textarea-bordered min-h-28 w-full resize-none font-mono text-xs"
            rows={4}
            placeholder="Paste connection text here…"
            value={props.pastedText}
            onInput={(event) => props.onPasteText((event.currentTarget as HTMLTextAreaElement).value)}
            aria-label="Paste Pairwire invitation or response"
            aria-describedby="pairing-paste-status"
          />
          <div id="pairing-paste-status" aria-live="polite" class="min-h-6">
            {props.pastedType === "invitation" && <div class="text-xs text-success font-medium">✓ Invitation recognised</div>}
            {props.pastedType === "response" && <div class="text-xs text-success font-medium">✓ Response recognised</div>}
            {props.pastedError && <div class="text-xs text-error">{props.pastedError}</div>}
          </div>
          <button class="btn btn-primary w-full" type="button" disabled={busy || !props.pastedType} onClick={props.pastedType === "invitation" ? props.onAcceptInvitation : props.onCompleteResponse}>
            {busy && (props.busyAction === "accept" || props.busyAction === "complete")
              ? <span class="loading loading-spinner loading-xs" />
              : actionLabel}
          </button>
        </div>
      </section>

      <div class="alert alert-info mx-6 my-5 text-xs max-sm:mx-4"><span>Only exchange invitations with people you intend to connect with. They contain temporary connection details.</span></div>
    </div>
    <form method="dialog" class="modal-backdrop"><button type="button" onClick={props.onClose}>close</button></form>
  </dialog>;
}
