"use client";

import { useEffect, useRef } from "react";
import type Hls from "hls.js";
import { useResumeGeneration } from "@/lib/use-resume";

/**
 * `inline`: for phones. No native controls, and a tap never opens the iOS fullscreen player
 * (playsInline + webkit-playsinline, pointer events off the <video>, and any fullscreen that
 * still starts is exited at once). The parent handles taps.
 */
export function StreamPlayer({ src, inline = false }: { src: string; inline?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resume = useResumeGeneration(); // rebuild after the background (iOS suspends media)

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let cancelled = false;

    const start = async () => {
      const { default: HlsLib } = await import("hls.js");
      if (cancelled || !videoRef.current) return;
      const node = videoRef.current;
      if (HlsLib.isSupported()) {
        hls = new HlsLib({
          enableWorker: false,
          lowLatencyMode: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 6,
        });
        hls.loadSource(src);
        hls.attachMedia(node);
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
          node.play().catch(() => undefined);
        });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          }
        });
        return;
      }
      if (node.canPlayType("application/vnd.apple.mpegurl")) {
        node.src = resume ? `${src}${src.includes("?") ? "&" : "?"}r=${resume}` : src;
        node.play().catch(() => undefined);
      }
    };

    void start();

    // iOS can still enter its native player (e.g. double-tap); bounce straight back out.
    const node = video as HTMLVideoElement & { webkitExitFullscreen?: () => void };
    const exitNative = () => {
      try {
        node.webkitExitFullscreen?.();
      } catch {
        /* not in fullscreen */
      }
    };
    if (inline) node.addEventListener("webkitbeginfullscreen", exitNative);

    return () => {
      cancelled = true;
      if (inline) node.removeEventListener("webkitbeginfullscreen", exitNative);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, inline, resume]);

  return (
    <video
      ref={videoRef}
      className={`absolute inset-0 h-full w-full bg-[#111111] object-contain ${inline ? "pointer-events-none" : ""}`}
      autoPlay
      muted
      playsInline
      controls={!inline}
      disablePictureInPicture={inline || undefined}
      disableRemotePlayback={inline || undefined}
      {...(inline ? { "webkit-playsinline": "true", "x-webkit-airplay": "deny" } : {})}
    />
  );
}
