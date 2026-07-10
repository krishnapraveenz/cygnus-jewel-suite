// Optional modules a jeweller can switch on/off (e.g. Loose Stones — not everyone uses it).
// Persisted in localStorage (instant, drives the sidebar) and mirrored to server settings
// (key "modules.<id>" = "on" | "off") so the choice syncs across devices.
import { setSetting } from "@/api";

const LS = "cygnus_modules";

export type ModuleId = "loose_stones" | "schemes";

// Default visibility for each optional module.
const DEFAULTS: Record<ModuleId, boolean> = {
  loose_stones: true,
  schemes: true,
};

function readAll(): Record<string, boolean> {
  try {
    const v = localStorage.getItem(LS);
    return v ? (JSON.parse(v) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function isModuleOn(id: ModuleId): boolean {
  const all = readAll();
  return id in all ? !!all[id] : DEFAULTS[id];
}

/** Update local state + notify listeners. Pass `mirror` to also persist to the server. */
export function setModuleOn(id: ModuleId, on: boolean, mirror = true) {
  const all = readAll();
  all[id] = on;
  try {
    localStorage.setItem(LS, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("cygnus:modules"));
  if (mirror) setSetting(`modules.${id}`, on ? "on" : "off").catch(() => {});
}

/** Apply server-stored module flags (called once on app load). Does not re-mirror. */
export function applyServerModules(settings: Record<string, string>) {
  (Object.keys(DEFAULTS) as ModuleId[]).forEach((id) => {
    const v = settings[`modules.${id}`];
    if (v === "on" || v === "off") setModuleOn(id, v === "on", false);
  });
}
