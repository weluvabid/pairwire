import { useEffect, useRef } from "preact/hooks";
import { initials } from "../../utils/formatting.js";

export function NameSetupModal({ open, value, saving, onChange, onSubmit }: { open: boolean; value: string; saving: boolean; onChange(value: string): void; onSubmit(event: SubmitEvent): void }) {
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
      <p id="name-setup-description" class="mt-2 text-sm leading-relaxed text-base-content/75">Choose the name other people will see when you connect. We'll remember it on this device.</p>
      <form class="mt-5 space-y-4" onSubmit={(event) => onSubmit(event as unknown as SubmitEvent)}>
        <fieldset class="fieldset">
          <label class="label" htmlFor="display-name-setup">Your display name</label>
          <input id="display-name-setup" class="input input-bordered w-full" name="display-name" value={value} maxLength={48} minLength={1} required autoComplete="nickname" autoFocus placeholder="Your name" onInput={(event) => onChange((event.currentTarget as HTMLInputElement).value)} />
        </fieldset>
        <div class="rounded-xl bg-base-200/70 p-3">
          <div class="mb-2 text-[.62rem] font-semibold tracking-widest text-base-content/75">PREVIEW</div>
          <div class="flex items-center gap-3"><div class="avatar placeholder"><div class="w-10 rounded-xl border border-success/10 bg-success/10 text-sm font-semibold text-success"><span>{initials(value || "?")}</span></div></div><strong class="text-sm">{value.trim() || "Your name"}</strong></div>
        </div>
        <div class="modal-action mt-2"><button class="btn btn-primary w-full" type="submit" disabled={saving || !value.trim()}>{saving ? <span class="loading loading-spinner loading-xs" /> : "Continue"}</button></div>
      </form>
    </div>
  </dialog>;
}
