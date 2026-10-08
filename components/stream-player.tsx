"use client";

import { useEffect, useRef } from "react";
import type Hls from "hls.js";

export function StreamPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

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
        node.src = src;
        node.play().catch(() => undefined);
      }
    };

    void start();

    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      className="absolute inset-0 h-full w-full bg-[#111111] object-contain"
      autoPlay
      muted
      playsInline
      controls
    />
  );
}
