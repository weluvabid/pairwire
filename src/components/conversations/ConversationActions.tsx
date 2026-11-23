import { createPortal } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function ConversationActions({ peerName, connected, onReconnect, onDetails, onDelete }: { peerName: string; connected: boolean; onReconnect(): void; onDetails(): void; onDelete(): void }) {
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
