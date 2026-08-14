/**
 * Copies the given text to the clipboard.
 * Resolves to `true` on success, `false` if the write was rejected
 * (e.g. permissions or an insecure context).
 */
export function copyToClipboard(text: string): Promise<boolean> {
  return navigator.clipboard
    .writeText(text)
    .then(() => true)
    .catch(() => false);
}
