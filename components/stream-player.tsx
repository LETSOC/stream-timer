"use client";

import { useEffect, useRef, useState } from "react";
import { PreviewBadge } from "@/components/preview-badge";
import { playWhep, whepPathFromHls, type WhepSession } from "@/lib/whep-client";
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
  // Relay previews try WebRTC (<1s, video only) first; sound or any failure → HLS.
  const whepPath = whepPathFromHls(src);
  const [hlsOnly, setHlsOnly] = useState(false);
  const [mode, setMode] = useState<"webrtc" | "hls" | null>(null);
  const [srcSeen, setSrcSeen] = useState(src);
  if (srcSeen !== src) { setSrcSeen(src); setHlsOnly(false); setMode(null); }
  const tryFast = whepPath !== null && !hlsOnly;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let cancelled = false;
    let whep: WhepSession | null = null;
    // Unmuting a WebRTC preview (no AAC in WebRTC) switches it to HLS, which has the sound.
    const onVolume = () => { if (whep && !video.muted) setHlsOnly(true); };
    video.addEventListener("volumechange", onVolume);

    const start = async () => {
      if (tryFast && whepPath) {
        try {
          whep = await playWhep(video, whepPath, { timeoutMs: 3000, onFail: () => { if (!cancelled) setHlsOnly(true); } });
          if (cancelled) { whep.stop(); return; }
          setMode("webrtc");
          return;
        } catch {
          whep = null;
          if (cancelled) return;
        }
      }
      setMode(whepPath ? "hls" : null);
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
      video.removeEventListener("volumechange", onVolume);
      if (inline) node.removeEventListener("webkitbeginfullscreen", exitNative);
      whep?.stop();
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, inline, resume, tryFast, whepPath]);

  return (
    <>
    <PreviewBadge mode={mode} />
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
    </>
  );
}
