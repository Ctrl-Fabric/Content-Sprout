/**
 * localStorage helpers that dual-read legacy Quirkstack `qs_*` / `qs.` / `QS_*` keys
 * while writing only the new (unprefixed) keys.
 */

function legacyKeys(key: string): string[] {
  // New keys are the old keys with leading `qs_` / `qs.` / `QS_` stripped.
  // If the key already looks legacy-prefixed, there is no further legacy form.
  if (key.startsWith('qs_') || key.startsWith('qs.') || key.startsWith('QS_')) {
    return [];
  }
  return [`qs_${key}`, `qs.${key}`, `QS_${key}`];
}

/** Read new key, then legacy forms; migrate when only legacy exists. */
export function storageGet(key: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current != null) {
      return current;
    }
    for (const legacy of legacyKeys(key)) {
      const old = localStorage.getItem(legacy);
      if (old != null) {
        localStorage.setItem(key, old);
        localStorage.removeItem(legacy);
        return old;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Write new key and remove any legacy counterparts. */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    for (const legacy of legacyKeys(key)) {
      localStorage.removeItem(legacy);
    }
  } catch {
    /* storage unavailable */
  }
}

/** Remove new key and any legacy counterparts. */
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
    for (const legacy of legacyKeys(key)) {
      localStorage.removeItem(legacy);
    }
  } catch {
    /* storage unavailable */
  }
}
