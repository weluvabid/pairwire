import { useEffect, useRef, useState } from 'preact/hooks';

export type PastedSignalingType = 'invitation' | 'response' | null;
export type PairingPhase = 'invitation-created' | 'response-created' | 'connecting' | null;

export function PairingModal(props: {
  open: boolean;
  reconnectPeerName: string | undefined;
  busyAction: string | null;
  invitationOutput: string;
  responseOutput: string;
  pastedText: string;
  pastedType: PastedSignalingType;
  pastedError: string | null;
  pairingPhase: PairingPhase;
  clipboardFallback: 'invitation-copy' | 'response-copy' | null;
  onClose(): void;
  onPasteText(value: string): void;
  onGenerate(): void;
  onReconnect(): void;
  onAcceptInvitation(): void;
  onCompleteResponse(): void;
  onCopyInvitation(): Promise<boolean>;
  onCopyResponse(): Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [copied, setCopied] = useState<'invitation' | 'response' | null>(null);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!props.open) {
      setCopied(null);
      return;
    }
    const kind =
      props.clipboardFallback === null && props.pairingPhase === 'invitation-created'
        ? 'invitation'
        : props.clipboardFallback === null && props.pairingPhase === 'response-created'
          ? 'response'
          : null;
    if (!kind) return;
    setCopied(kind);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      setCopied(null);
      copiedTimer.current = null;
    }, 2000);
  }, [props.open, props.pairingPhase, props.clipboardFallback]);

  const copy = async (kind: 'invitation' | 'response') => {
    const succeeded =
      kind === 'invitation' ? await props.onCopyInvitation() : await props.onCopyResponse();
    if (!succeeded) return;
    setCopied(kind);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      setCopied(null);
      copiedTimer.current = null;
    }, 2000);
  };

  const reconnectMode = Boolean(props.reconnectPeerName);
  const busy = Boolean(props.busyAction);
  const actionLabel =
    props.pastedType === 'invitation'
      ? 'Accept invitation'
      : props.pastedType === 'response'
        ? 'Complete connection'
        : 'Waiting for connection text';

  return (
    <dialog
      ref={dialogRef}
      class="modal"
      onClose={props.onClose}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="modal-box w-[min(34rem,calc(100vw-1.75rem))] max-w-none max-h-[88dvh] overflow-y-auto p-0">
        <div class="flex items-start justify-between gap-4 px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-5">
          <div>
            <div class="dialog-eyebrow mb-2">MAKE A CONNECTION</div>
            <h2 class="text-xl font-bold tracking-tight">Connect directly.</h2>
            <p class="mt-2 max-w-md text-xs leading-relaxed text-base-content/75">
              Exchange connection details through a messaging app you already use. Pairwire never
              sends your chat through a messaging server.
            </p>
          </div>
          <button
            class="btn btn-ghost btn-sm btn-square"
            type="button"
            onClick={props.onClose}
            aria-label="Close pairing dialog"
          >
            ✕
          </button>
        </div>

        {props.pairingPhase && (
          <div
            class="mx-6 mb-2 rounded-box bg-info/10 px-4 py-3 text-xs text-info-content max-sm:mx-4"
            role="status"
            aria-live="polite"
          >
            {props.pairingPhase === 'invitation-created' &&
              'Invitation created. Share it with the other person, then paste their response here.'}
            {props.pairingPhase === 'response-created' &&
              'Response created. Send it back to the inviter so they can complete the connection.'}
            {props.pairingPhase === 'connecting' &&
              'Response received. Pairwire is establishing the direct connection… Keep this dialog open.'}
          </div>
        )}
        <section class="space-y-4 px-6 pt-2 max-sm:px-4">
          {!reconnectMode ? (
            <div class="rounded-box border border-base-300 p-4 space-y-3">
              <div>
                <div class="text-sm font-semibold">Start a new conversation</div>
                <p class="mt-1 text-xs leading-relaxed text-base-content/75">
                  Create an invitation and share it with someone.
                </p>
              </div>
              <button
                class="btn btn-primary w-full"
                type="button"
                disabled={busy}
                onClick={props.onGenerate}
              >
                {props.busyAction === 'generate' ? (
                  <span class="loading loading-spinner loading-xs" />
                ) : copied === 'invitation' ? (
                  'Copied to clipboard'
                ) : (
                  'Create & copy invitation'
                )}
              </button>
              {props.invitationOutput && (
                <div class="space-y-2">
                  <label
                    class="label py-0 text-xs font-medium"
                    htmlFor="pairwire-invitation-output"
                  >
                    Your invitation — send this to the other person
                  </label>
                  <textarea
                    id="pairwire-invitation-output"
                    class="textarea textarea-bordered min-h-24 w-full resize-none font-mono text-xs"
                    rows={4}
                    readOnly
                    value={props.invitationOutput}
                  />
                  {props.clipboardFallback === 'invitation-copy' && (
                    <p class="text-xs text-warning">
                      Automatic copying wasn&apos;t available. Select the text above and copy it
                      manually.
                    </p>
                  )}
                  <button
                    class="btn btn-outline btn-sm"
                    type="button"
                    onClick={() => void copy('invitation')}
                  >
                    {copied === 'invitation' ? 'Copied to clipboard' : 'Copy invitation'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div class="rounded-box border border-base-300 p-4 space-y-3">
              <div>
                <div class="text-sm font-semibold">Reconnect with {props.reconnectPeerName}</div>
                <p class="mt-1 text-xs leading-relaxed text-base-content/75">
                  Create a fresh invitation to restore your existing conversation. Your history
                  stays on this device.
                </p>
              </div>
              <button
                class="btn btn-primary w-full"
                type="button"
                disabled={busy}
                onClick={props.onReconnect}
              >
                {props.busyAction === 'reconnect' ? (
                  <span class="loading loading-spinner loading-xs" />
                ) : copied === 'invitation' ? (
                  'Copied to clipboard'
                ) : (
                  'Create & copy new invitation'
                )}
              </button>
              {props.invitationOutput && (
                <div class="space-y-2">
                  <label
                    class="label py-0 text-xs font-medium"
                    htmlFor="pairwire-invitation-output"
                  >
                    Your invitation — send this to {props.reconnectPeerName}
                  </label>
                  <textarea
                    id="pairwire-invitation-output"
                    class="textarea textarea-bordered min-h-24 w-full resize-none font-mono text-xs"
                    rows={4}
                    readOnly
                    value={props.invitationOutput}
                  />
                  {props.clipboardFallback === 'invitation-copy' && (
                    <p class="text-xs text-warning">
                      Automatic copying wasn&apos;t available. Select the text above and copy it
                      manually.
                    </p>
                  )}
                  <button
                    class="btn btn-outline btn-sm"
                    type="button"
                    onClick={() => void copy('invitation')}
                  >
                    {copied === 'invitation' ? 'Copied to clipboard' : 'Copy invitation'}
                  </button>
                </div>
              )}
            </div>
          )}

          <div class="rounded-box border border-base-300 p-4 space-y-3">
            <div>
              <div class="text-sm font-semibold">Paste what they sent you</div>
              <p class="mt-1 text-xs leading-relaxed text-base-content/75">
                Paste an invitation or response. Pairwire will identify it and show the right next
                step.
              </p>
            </div>
            <label class="label py-0 text-xs font-medium" htmlFor="pairwire-signaling-input">
              Received invitation or response
            </label>
            <textarea
              id="pairwire-signaling-input"
              class="textarea textarea-bordered min-h-24 w-full resize-none font-mono text-xs"
              rows={4}
              placeholder="Paste the text you received here…"
              value={props.pastedText}
              onInput={(event) =>
                props.onPasteText((event.currentTarget as HTMLTextAreaElement).value)
              }
              aria-describedby="pairing-paste-status"
            />
            <div id="pairing-paste-status" aria-live="polite" class="min-h-6">
              {props.pastedType === 'invitation' && (
                <div class="badge badge-success badge-sm gap-1">✓ Invitation recognised</div>
              )}
              {props.pastedType === 'response' && (
                <div class="badge badge-success badge-sm gap-1">✓ Response recognised</div>
              )}
              {props.pastedError && (
                <div class="text-sm font-medium text-error" role="alert">
                  {props.pastedError}
                </div>
              )}
            </div>
            <button
              class="btn btn-primary w-full"
              type="button"
              disabled={busy || !props.pastedType}
              onClick={
                props.pastedType === 'invitation'
                  ? props.onAcceptInvitation
                  : props.onCompleteResponse
              }
            >
              {busy && (props.busyAction === 'accept' || props.busyAction === 'complete') ? (
                <span class="loading loading-spinner loading-xs" />
              ) : (
                actionLabel
              )}
            </button>
          </div>

          {props.responseOutput && (
            <div
              class="rounded-box border border-success/30 bg-success/5 p-4 space-y-3"
              aria-live="polite"
            >
              <div>
                <div class="text-sm font-semibold">Your response is ready</div>
                <p class="mt-1 text-xs leading-relaxed text-base-content/70">
                  Send this response back to the person who invited you. The connection is not
                  established until they complete the next step.
                </p>
              </div>
              <label class="label py-0 text-xs font-medium" htmlFor="pairwire-response-output">
                Your response — send this back to the inviter
              </label>
              <textarea
                id="pairwire-response-output"
                class="textarea textarea-bordered min-h-24 w-full resize-none font-mono text-xs"
                rows={4}
                readOnly
                value={props.responseOutput}
              />
              {props.clipboardFallback === 'response-copy' && (
                <p class="text-xs text-warning">
                  Automatic copying wasn&apos;t available. Select the text above and copy it
                  manually.
                </p>
              )}
              <button
                class="btn btn-outline btn-sm"
                type="button"
                onClick={() => void copy('response')}
              >
                {copied === 'response' ? 'Copied to clipboard' : 'Copy response'}
              </button>
            </div>
          )}
        </section>

        <div class="alert alert-info mx-6 my-5 text-xs max-sm:mx-4">
          <span>
            Only exchange invitations with people you intend to connect with. They contain temporary
            connection details.
          </span>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" onClick={props.onClose}>
          close
        </button>
      </form>
    </dialog>
  );
}
