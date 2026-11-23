import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function ConversationActions({
  peerName,
  connected,
  onReconnect,
  onDetails,
  onDelete,
}: {
  peerName: string;
  connected: boolean;
  onReconnect(): void;
  onDetails(): void;
  onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? 208;
    const height = menu?.offsetHeight ?? 168;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const placeBelow = height <= spaceBelow || spaceBelow >= spaceAbove;
    const desiredTop = placeBelow ? rect.bottom + 6 : rect.top - height - 6;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    setPosition({
      top: Math.max(margin, Math.min(desiredTop, maxTop)),
      left: Math.max(margin, Math.min(rect.right - width, maxLeft)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const action = (callback: () => void) => {
    setOpen(false);
    callback();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        class="btn btn-ghost btn-xs btn-square h-7 min-h-7 w-7 conversation-menu-trigger"
        aria-label={`Actions for ${peerName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          updatePosition();
          setOpen(true);
        }}
      >
        <span aria-hidden="true">···</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            class="fixed z-[100]"
            style={{ top: `${position.top}px`, left: `${position.left}px`, width: '13rem' }}
          >
            <ul
              class="menu conversation-actions-menu rounded-box border border-base-300 bg-base-100 p-1.5 text-sm shadow-xl"
              role="menu"
              aria-label={`${peerName} conversation actions`}
              onKeyDown={(event) => {
                const items = Array.from(
                  menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
                    [],
                );
                const index = items.indexOf(event.target as HTMLButtonElement);
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  items[
                    (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                  ]?.focus();
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  items[0]?.focus();
                } else if (event.key === 'End') {
                  event.preventDefault();
                  items.at(-1)?.focus();
                } else if (event.key === 'Tab') {
                  setOpen(false);
                }
              }}
            >
              <li>
                <button
                  type="button"
                  role="menuitem"
                  class="conversation-action-item"
                  disabled={connected}
                  onClick={() => action(onReconnect)}
                >
                  <span aria-hidden="true">↻</span>
                  {connected ? 'Already connected' : 'Reconnect'}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  class="conversation-action-item"
                  onClick={() => action(onDetails)}
                >
                  <span aria-hidden="true">ⓘ</span>Connection details
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  class="conversation-action-item is-destructive"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                    onDelete();
                  }}
                >
                  <span aria-hidden="true">⌫</span>Delete conversation
                </button>
              </li>
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
