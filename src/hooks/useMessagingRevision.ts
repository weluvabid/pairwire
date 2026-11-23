import { useEffect, useState } from "preact/hooks";

const listeners = new Set<() => void>();

export function emitMessagingChange(): void {
  for (const listener of listeners) listener();
}

export function subscribeMessagingChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMessagingRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeMessagingChange(() => setRevision((current) => current + 1)), []);
  return revision;
}
