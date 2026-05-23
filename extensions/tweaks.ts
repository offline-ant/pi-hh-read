/**
 * Tweaks — small session-level adjustments.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    let active = pi.getActiveTools();
    // Disable built-in edit/write — we use change_file (with hashline verification) instead
    active = active.filter((name) => name !== "edit" && name !== "write");
    pi.setActiveTools(active);
  });
}
