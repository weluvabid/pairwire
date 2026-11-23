import { useEffect, useRef } from 'preact/hooks';
import type { PeerRecord } from '../../core/types.js';

export function DeleteConversationModal({
  peer,
  pendingCount,
  busy,
  onCancel,
  onConfirm,
}: {
  peer: PeerRecord | null;
  pendingCount: number;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (peer && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!peer && dialog.open) {
      dialog.close();
    }
  }, [peer]);

  return (
    <dialog
      ref={dialogRef}
      class="modal"
      aria-labelledby="delete-conversation-title"
      aria-describedby="delete-conversation-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      {peer && (
        <div class="modal-box max-w-md">
          <h2 id="delete-conversation-title" class="text-lg font-bold">
            Delete conversation with {peer.name}?
          </h2>
          <p id="delete-conversation-description" class="mt-2 text-sm text-base-content/75">
            This permanently deletes the conversation history and peer details stored in this
            browser. It cannot be undone. The other person&apos;s copy is not affected.
          </p>
          {pendingCount > 0 && (
            <div class="alert alert-warning mt-4 text-xs" role="note">
              {pendingCount} queued {pendingCount === 1 ? 'message' : 'messages'} will also be
              deleted and cannot be delivered later.
            </div>
          )}
          <div class="modal-action">
            <button
              ref={cancelRef}
              type="button"
              class="btn btn-ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button type="button" class="btn btn-error" disabled={busy} onClick={onConfirm}>
              {busy ? (
                <>
                  <span class="loading loading-spinner loading-xs" aria-hidden="true" />
                  Deleting…
                </>
              ) : (
                'Delete conversation'
              )}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
