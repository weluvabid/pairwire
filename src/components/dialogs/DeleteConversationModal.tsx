import type { PeerRecord } from "../../core/types.js";

export function DeleteConversationModal({ peer, pendingCount, busy, onCancel, onConfirm }: { peer: PeerRecord | null; pendingCount: number; busy: boolean; onCancel(): void; onConfirm(): void }) {
  if (!peer) return null;
  return <div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title"><div class="modal-box max-w-md">
    <h2 id="delete-conversation-title" class="text-lg font-bold">Delete conversation with {peer.name}?</h2>
    <p class="mt-2 text-sm text-base-content/65">This permanently deletes the conversation history and peer details stored in this browser. It cannot be undone. The other person's copy is not affected.</p>
    {pendingCount > 0 && <div class="alert alert-warning mt-4 text-xs">{pendingCount} queued {pendingCount === 1 ? "message" : "messages"} will also be deleted and cannot be delivered later.</div>}
    <div class="modal-action"><button type="button" class="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" class="btn btn-error" disabled={busy} onClick={onConfirm}>{busy ? <span class="loading loading-spinner loading-xs" /> : "Delete conversation"}</button></div>
  </div><button type="button" class="modal-backdrop" aria-label="Close delete confirmation" onClick={onCancel} /></div>;
}
