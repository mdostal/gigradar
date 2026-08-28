"use client";

// config-version-channel-readout story (tauri-update-notification epic):
// nothing anywhere in this app showed which version was actually running
// or which update channel (Dev/Prod) it was on -- confirmed absent by grep
// while planning. This caused real confusion this same session: a packaged
// .app running old code was mistaken for current, with no way to check
// from inside the app itself. Standalone (not folded into ConfigClient's
// giant form) because this is read-only, external, Tauri-native state --
// not part of Config/ConfigEdits, has nothing to Save.
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/is-tauri";

export function TauriVersionReadout() {
  const [info, setInfo] = useState<{ version: string; channel: "dev" | "prod" } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    (async () => {
      const [{ getVersion }, { invoke }] = await Promise.all([
        import("@tauri-apps/api/app"),
        import("@tauri-apps/api/core"),
      ]);
      const [version, channel] = await Promise.all([getVersion(), invoke<string>("get_update_channel")]);
      if (!cancelled) setInfo({ version, channel: channel === "dev" ? "dev" : "prod" });
    })().catch((err) => {
      console.error("gigradar: TauriVersionReadout failed to load version/channel", err);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;

  return (
    <p className="mt-2 text-xs text-theme-text-dim">
      Running v{info.version} on the{" "}
      <span
        className={
          info.channel === "dev"
            ? "inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-inset ring-amber-300"
            : "font-medium text-theme-text"
        }
      >
        {info.channel === "dev" ? "Dev" : "Prod"}
      </span>{" "}
      update channel.
    </p>
  );
}
