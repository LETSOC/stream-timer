"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import type { EncoderStatus } from "@/lib/encoder-status";
import { StreamPlayer } from "@/components/stream-player";
import { handleUnauthorized } from "@/lib/use-operator";

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
  encoderState: "stopped",
  rtmpState: "stopped",
  stopNote: null,
  rtmpRunning: false,
  rtmpReconnecting: false,
  rtmpRestarts: 0,
  rtmpConnectError: null,
  rtmpFailure: null,
  rtmpLogTail: "",
  strayPublishers: [], rtmpAdopted: false, rtmpOwnProcesses: 0,
};

const ENCODER_LABEL: Record<EncoderStatus["encoderState"], string> = {
  stopped: "Player off",
  starting: "Starting…",
  running: "Player live",
  stalled: "Stalled · restart",
}
const ENCODER_TONE: Record<EncoderStatus["encoderState"], string> = {
  stopped: "bg-black/5 text-black/70",
  starting: "bg-black text-white",
  running: "bg-[#128a3e] text-white",
  stalled: "bg-[#d93200] text-white",
}

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
  const [status, setStatus] = useState<EncoderStatus>(emptyStatus);
  const [refreshSlate, setRefreshSlate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [playlistUrl, setPlaylistUrl] = useState("/media/stream.m3u8")
  useEffect(() => {
    setPlaylistUrl(`${window.location.origin}/media/stream.m3u8`)
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/encoder", { cache: "no-store" });
    if (handleUnauthorized(response) || !response.ok) return;
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


  async function start(replace = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/encoder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventName,
          dateLine,
          targetUnix,
          refreshSeconds: refreshSlate ? 600 : 0,
          replace,
        }),
      });
      if (handleUnauthorized(response)) return;
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
      const response = await fetch("/api/encoder", {
        method: "DELETE",
      });
      if (handleUnauthorized(response)) return;
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
        <span role="status" title="HLS preview health: the playlist must keep advancing" className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[12px] font-bold tracking-[0.14em] uppercase ${ENCODER_TONE[status.encoderState]}`}>
          <span className={`size-1.5 rounded-full ${status.encoderState === "running" ? "animate-pulse bg-white" : status.encoderState === "stopped" ? "bg-black/30" : "bg-white"}`} />
          {ENCODER_LABEL[status.encoderState]}
        </span>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={pill("solid")} disabled={busy || status.running || !valid || !status.ffmpeg} onClick={() => void start(false)}>
            Play encoded slate
          </button>
          <button type="button" className={pill("outline")} disabled={busy || !status.running} onClick={() => void start(true)}>
            Restart slate
          </button>
          <ConfirmButton className={pill("danger")} disabled={busy || !status.running} onConfirm={() => void stop()}>
            Stop player
          </ConfirmButton>
        </div>
        <p className="font-mono text-[13px] break-all text-black/70">{playlistUrl}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={pill("solid")}
            onClick={() => {
              void navigator.clipboard?.writeText(playlistUrl).then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? "Copied" : "Copy m3u8 link"}
          </button>
          <a className={`${pill("outline")} no-underline`} href={playlistUrl} target="_blank" rel="noreferrer">
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
              <p className="max-w-sm font-mono text-[13px] leading-5 text-white/75">
                1280×720 · 30 fps · H.264 2500 kbps · silent stereo. This player is local. Start stream sends the same picture to RTMP.
              </p>
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 font-mono text-[13px] text-black/70">
          <input type="checkbox" checked={refreshSlate} onChange={(event) => setRefreshSlate(event.target.checked)} />
          Auto-refresh the burned-in clock every 10 minutes
        </label>
        {status.running && status.slateAgeSeconds !== null ? (
          <p className="font-mono text-[13px] text-black/70">
            Slate age {status.slateAgeSeconds}s.
            {status.refreshSeconds ? " Auto-refresh is on." : " Auto-refresh is off."}
          </p>
        ) : null}
        {status.stopNote ? <p className="font-mono text-[13px] text-[#a32600]">{status.stopNote}</p> : null}
        {!status.ffmpeg ? <p className="font-mono text-[13px] text-red-600">ffmpeg is not on PATH. The browser preview still runs.</p> : null}
        {stale ? <p className="font-mono text-[13px] text-black/70">The form changed after this encode started. Restart the slate to burn in the new title.</p> : null}
        {error ? <pre className="max-h-36 overflow-auto rounded-xl bg-[#F6F6F3] p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap text-red-700">{error}</pre> : null}
      </div>
    </section>
  )
}

function pill(tone: "solid" | "outline" | "danger") {
  const tones = {
    solid: "bg-black text-white hover:-translate-y-px hover:bg-[#222] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)]",
    outline: "border border-black bg-white text-black hover:-translate-y-px hover:bg-black hover:text-white",
    danger: "border-2 border-[#b42318] bg-white text-[#b42318] before:mr-1.5 before:content-['⚠'] hover:-translate-y-px hover:bg-[#b42318] hover:text-white",
  }
  return `inline-flex h-9 items-center justify-center rounded-full px-5 text-[13px] font-medium whitespace-nowrap transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${tones[tone]}`
}
