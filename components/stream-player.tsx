"use client";

import { useEffect, useRef, useState } from "react";
import { PreviewBadge } from "@/components/preview-badge";
import { useAutoHide } from "@/components/auto-hide";
import { AudioBar, usePreviewAudio } from "@/components/preview-audio";
import { whepPathFromHls } from "@/lib/whep-client";
import { useWhep } from "@/lib/use-whep";
import type Hls from "hls.js";
import { useResumeGeneration } from "@/lib/use-resume";

/**
 * `inline`: for phones. No native controls, and a tap never opens the iOS fullscreen player
 * (playsInline + webkit-playsinline, pointer events off the <video>, and any fullscreen that
 * still starts is exited at once). The parent handles taps.
 */
/** Scope for the saved mute choice: one per preview (capture, slate, vertical, …), not per mount. */
export function previewScope(src: string): string {
  return /\/hls\/([^/]+)\//.exec(src)?.[1] ?? (src.startsWith("/media/") ? "encoded" : "preview");
}

export function StreamPlayer({ src, inline = false, scope }: { src: string; inline?: boolean; scope?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<HTMLVideoElement>(null);
  const resume = useResumeGeneration(); // rebuild after the background (iOS suspends media)
  // Relay previews: WebRTC (<1s, picture only) in its own element on top. Sound (unmute) or a WebRTC
  // failure starts HLS underneath; the WebRTC picture stays until HLS has a frame, then it's closed.
  // Sticky for this player: muting again stays on HLS (no swap back mid-session).
  const whepPath = whepPathFromHls(src);
  const audioScope = `${scope ?? previewScope(src)}${inline ? ":deck" : ":desk"}`;
  // Same audio bar as the program preview; the HLS element carries the sound (WebRTC has none).
  const audio = usePreviewAudio(videoRef, audioScope);
  const [wantHlsState, setWantHls] = useState(false);
  if (!audio.pref.muted && !wantHlsState) setWantHls(true);
  const wantHls = wantHlsState;
  const [hlsPlaying, setHlsPlaying] = useState(false);
  const [seen, setSeen] = useState(src);
  if (seen !== src) { setSeen(src); setWantHls(!audio.pref.muted); setHlsPlaying(false); }
  const swapped = whepPath !== null && hlsPlaying && wantHls;
  const rtc = useWhep(rtcRef, whepPath, whepPath !== null && !swapped);
  const needHls = whepPath === null || wantHls || rtc.failed;
  const showRtc = whepPath !== null && !rtc.failed && !(needHls && hlsPlaying);
  const chrome = useAutoHide();
  // The WebRTC element never has sound; keep it muted. Re-apply the user's choice once HLS is up.
  useEffect(() => { if (rtcRef.current) rtcRef.current.muted = true; });
  const { apply } = audio;
  useEffect(() => { apply(); }, [swapped, hlsPlaying, apply]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !needHls) return;
    const onPlaying = () => { if (video.readyState >= 2) setHlsPlaying(true); };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onPlaying);

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
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onPlaying);
      if (inline) node.removeEventListener("webkitbeginfullscreen", exitNative);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, inline, resume, needHls]);

  const vClass = `absolute inset-0 h-full w-full bg-[#111111] object-contain ${inline ? "pointer-events-none" : ""}`;
  const inlineProps = inline ? { "webkit-playsinline": "true", "x-webkit-airplay": "deny" } : {};
  return (
    <div className="absolute inset-0 outline-none" data-testid="stream-player" tabIndex={inline ? undefined : 0} aria-label="Preview player (focus to show controls)" {...chrome.bind}>
      <video
        ref={videoRef}
        data-active={showRtc ? undefined : "1"}
        className={vClass}
        autoPlay
        muted
        playsInline
                disablePictureInPicture={inline || undefined}
        disableRemotePlayback={inline || undefined}
        {...inlineProps}
      />
      {whepPath !== null ? (
        <video
          ref={rtcRef}
          data-active={showRtc ? "1" : undefined}
          className={`${vClass} ${showRtc ? "" : "invisible"}`}
          autoPlay
          muted
          playsInline
                    disablePictureInPicture={inline || undefined}
          disableRemotePlayback={inline || undefined}
          {...inlineProps}
        />
      ) : null}
      <AudioBar audio={audio} scope={audioScope} shown={chrome.shown} />
      <PreviewBadge idle={chrome.idle} mode={whepPath === null ? null : showRtc ? (rtc.lastFrameAt !== null ? "webrtc" : null) : "hls"} />
    </div>
  );
}
