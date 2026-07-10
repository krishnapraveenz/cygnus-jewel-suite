// Which rate chips show in the top-bar ticker. Keys are "metal:purityLabel"
// (e.g. "gold:22K", "silver:999", "platinum:950") or the special "diamond".
// Persisted in localStorage (instant) and mirrored to server settings (ticker.items).

const LS = "cygnus_ticker_items";
export const DEFAULT_TICKER = ["gold:24K", "gold:22K", "silver:999"];

export function getTickerItems(): string[] {
  try {
    const v = localStorage.getItem(LS);
    const arr = v ? (JSON.parse(v) as string[]) : DEFAULT_TICKER;
    return Array.isArray(arr) ? arr : DEFAULT_TICKER;
  } catch {
    return DEFAULT_TICKER;
  }
}

export function setTickerItems(items: string[]) {
  try {
    localStorage.setItem(LS, JSON.stringify(items));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("cygnus:ticker"));
}
