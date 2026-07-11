/**
 * OTA Update utilities — wraps @tauri-apps/plugin-updater.
 *
 * The Tauri updater plugin is configured in tauri.conf.json with:
 *   endpoint: http://<server>:8787/api/update/{{target}}/{{arch}}/{{current_version}}
 *
 * The server proxies GitHub Releases (private repo) using its own GITHUB_UPDATE_TOKEN.
 * The client never sees or stores the GitHub token.
 *
 * At runtime, the endpoint is overridden to use the actual server address (cygnus_base)
 * since tauri.conf.json can only have a static default.
 */

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateStatus {
  available: boolean;
  version?: string;
  notes?: string;
  date?: string;
}

export interface DownloadProgress {
  total: number;
  downloaded: number;
  /** 0-100 */
  percent: number;
}

/**
 * Check if an update is available. Returns null if no update or if the check fails
 * (network error, no server configured, etc.) — never throws.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const update = await check();
    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
        date: update.date ?? undefined,
      };
    }
    return { available: false };
  } catch (e) {
    console.warn("[updater] check failed:", e);
    return { available: false };
  }
}

/**
 * Download and install the update, with progress callback.
 * After install completes, calls relaunch() to restart the app.
 */
export async function downloadAndInstall(
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const update = await check();
  if (!update) throw new Error("No update available");

  let downloaded = 0;
  let total = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress?.({ total, downloaded: 0, percent: 0 });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        onProgress?.({ total, downloaded, percent });
        break;
      case "Finished":
        onProgress?.({ total, downloaded: total, percent: 100 });
        break;
    }
  });

  // Restart the app to apply the update
  await relaunch();
}
