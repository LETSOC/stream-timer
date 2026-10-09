"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EncoderStatus } from "@/lib/encoder-status";
import { StreamPlayer } from "@/components/stream-player";
import { useEncoderToken } from "@/lib/use-encoder-token";

const emptyStatus: EncoderStatus = {
  running: false,
  playlistReady: false,
  pid: null,
  logTail: "",
  ffmpeg: true,
  eventName: null,
  dateLine: null,
  targetUnix: null,
  startedAt: null,
  slateAgeSeconds: null,
  burnedRemainingAtStart: null,
  refreshSeconds: null,
  rtmpRunning: false,
  rtmpReconnecting: false,
  rtmpRestarts: 0,
  rtmpLogTail: "",
  strayPublishers: [],
};

export function EncodedPreview({
  eventName,
  dateLine,
  targetUnix,
  valid,
}: {
  eventName: string;
  dateLine: string;
  targetUnix: number;
  valid: boolean;
}) {
  const token = useEncoderToken();
  const [status, setStatus] = useState<EncoderStatus>(emptyStatus);
  const [refreshSlate, setRefreshSlate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const playlistUrl = typeof window === "undefined" ? "/media/stream.m3u8" : `${window.location.origin}/media/stream.m3u8`;

  const refresh = useCallback(async () => {
    const response = await fetch("/api/encoder", { cache: "no-store" });
    if (!response.ok) return;
    setStatus((await response.json()) as EncoderStatus);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refresh().catch(() => undefined);
    }, 0);
    const poll = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
    };
  }, [refresh]);

  const playing = status.running && status.playlistReady;
  const stale =
    status.running &&
    (status.eventName !== eventName ||
      status.dateLine !== dateLine ||
      status.targetUnix !== targetUnix);

  async function authToken() {
    if (token) return token
    const boot = await fetch("/api/event", { cache: "no-store" }).then((response) => response.json()).catch(() => null)
    return typeof boot?.token === "string" ? boot.token : ""
  }

  async function start(replace = false) {
    setBusy(true);
    setError(null);
    try {
      const auth = await authToken()
      if (!auth) {
        setError("The encoder token was not issued. Open the desk at http://localhost:43211.")
        return
      }
      const response = await fetch("/api/encoder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-encoder-token": auth,
        },
        body: JSON.stringify({
          eventName,
          dateLine,
          targetUnix,
          refreshSeconds: refreshSlate ? 600 : 0,
          replace,
        }),
      });
      const body = (await response.json()) as EncoderStatus & { error?: string };
      if (!response.ok) {
        setError(body.error || "ffmpeg did not start.");
        return;
      }
      setStatus(body);
    } catch {
      setError("The player could not reach the encoder.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const auth = await authToken()
      const response = await fetch("/api/encoder", {
        method: "DELETE",
        headers: { "x-encoder-token": auth },
      });
      if (response.ok) setStatus((await response.json()) as EncoderStatus);
    } catch {
      setError("The player could not stop ffmpeg.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-[20px] border border-black/10 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/10 px-5 py-4">
        <h2 className="text-[13px] font-black tracking-[0.12em] uppercase">Encoded player</h2>
        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[10px] font-bold tracking-[0.14em] uppercase ${status.rtmpRunning ? "bg-[#128a3e] text-white" : "bg-black/5 text-black/45"}`}>
          <span className={`size-1.5 rounded-full ${status.rtmpRunning ? "animate-pulse bg-white" : "bg-black/30"}`} />
          {status.rtmpRunning ? "Stream live" : "Stream off"}
        </span>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40" disabled={busy || status.running || !valid || !status.ffmpeg} onClick={() => void start(false)}>
            Play encoded slate
          </button>
          <button type="button" className="rounded-full border border-black bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40" disabled={busy || !status.running} onClick={() => void start(true)}>
            Restart slate
          </button>
          <button type="button" className="rounded-full border border-black bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40" disabled={busy || !status.running} onClick={() => void stop()}>
            Stop player
          </button>
        </div>
        <p className="font-mono text-[11px] break-all text-black/70">{playlistUrl}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white"
            onClick={() => {
              void navigator.clipboard.writeText(playlistUrl).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? "Copied" : "Copy m3u8 link"}
          </button>
          <a className="rounded-full border border-black bg-white px-4 py-2 text-sm font-medium text-black no-underline" href={playlistUrl} target="_blank" rel="noreferrer">
            Open m3u8 in new tab
          </a>
        </div>
        <div className="relative aspect-video overflow-hidden rounded-[16px] border border-black/10 bg-black">
          {playing && status.pid ? (
            <StreamPlayer src={`/media/stream.m3u8?run=${status.pid}`} />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
              <p className="font-mono text-[12px] text-white/80">
                {status.running ? "Writing the first two-second segment." : "Play the encoded slate to preview it here."}
              </p>
              <p className="max-w-sm font-mono text-[11px] leading-5 text-white/45">
                1280×720 · 30 fps · H.264 2500 kbps · silent stereo. This player is local. Start stream sends the same picture to RTMP.
              </p>
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 font-mono text-[11px] text-black/60">
          <input type="checkbox" checked={refreshSlate} onChange={(event) => setRefreshSlate(event.target.checked)} />
          Auto-refresh the burned-in clock every 10 minutes
        </label>
        {status.running && status.slateAgeSeconds !== null ? (
          <p className="font-mono text-[11px] text-black/50">
            Slate age {status.slateAgeSeconds}s.
            {status.refreshSeconds ? " Auto-refresh is on." : " Auto-refresh is off."}
          </p>
        ) : null}
        {!status.ffmpeg ? <p className="font-mono text-[11px] text-red-600">ffmpeg is not on PATH. The browser preview still runs.</p> : null}
        {stale ? <p className="font-mono text-[11px] text-black/50">The form changed after this encode started. Restart the slate to burn in the new title.</p> : null}
        {error ? <pre className="max-h-36 overflow-auto rounded-xl bg-[#F6F6F3] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-red-700">{error}</pre> : null}
      </div>
    </section>
  )
}
