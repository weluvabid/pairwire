import { useEffect, useRef } from "preact/hooks";

export function DetailsModal({ open, connection, peer, connected, onClose, onDisconnect }: { open: boolean; connection: string; peer: string; connected: boolean; onClose(): void; onDisconnect(): void }) {
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
