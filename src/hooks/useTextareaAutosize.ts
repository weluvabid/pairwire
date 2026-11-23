import { useEffect } from 'preact/hooks';

export function useTextareaAutosize(
  inputRef: { current: HTMLTextAreaElement | null },
  value: string,
  minHeight = 64,
  maxHeight = 144,
): void {
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, minHeight), maxHeight)}px`;
  }, [inputRef, value, minHeight, maxHeight]);
}
