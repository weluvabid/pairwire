export type ClipboardFailure = "unsupported" | "permission-denied" | "unavailable" | "empty";

export class ClipboardAccessError extends Error {
  constructor(message: string, readonly reason: ClipboardFailure) {
    super(message);
    this.name = "ClipboardAccessError";
  }
}

export async function writeClipboardText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new ClipboardAccessError("Clipboard writing is unavailable in this browser context.", "unsupported");
  }

  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
    throw new ClipboardAccessError(
      denied ? "Clipboard permission was denied. Copy the text manually instead." : "Could not write to the clipboard. Copy the text manually instead.",
      denied ? "permission-denied" : "unavailable",
    );
  }
}
