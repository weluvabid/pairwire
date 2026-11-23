/**
 * Returns true when text contains ASCII control characters, including DEL.
 * A code-point scan avoids embedding literal control ranges in regular expressions.
 */
export function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
