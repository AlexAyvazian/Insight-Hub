/** Small workspace preferences only; fetched intelligence is saved by the API in Neon. */
export function loadWorkspacePreference<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(value) ? value : fallback;
  } catch { return fallback; }
}

export function saveWorkspacePreference(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preferences still work for this session. */ }
}
