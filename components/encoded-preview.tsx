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
  const [refreshSlate, setRefreshSlate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function start(replace = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/encoder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-encoder-token": token,
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
      const response = await fetch("/api/encoder", {
        method: "DELETE",
        headers: { "x-encoder-token": token },
      });
      if (response.ok) setStatus((await response.json()) as EncoderStatus);
    } catch {
      setError("The player could not stop ffmpeg.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm tracking-[0.2em] text-zinc-400 uppercase">
          FFmpeg output
        </h2>
        <div className="flex gap-2">
          <Button
            disabled={busy || status.running || !valid || !status.ffmpeg || !token}
            onClick={() => void start(false)}
          >
            Play encoded slate
          </Button>
          <Button
            variant="outline"
            disabled={busy || !status.running || !token}
            onClick={() => void start(true)}
          >
            Restart slate
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !status.running || !token}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        </div>
      </div>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-[#111111] ring-1 ring-white/10">
        {playing && status.pid ? (
          <StreamPlayer src={`/media/stream.m3u8?run=${status.pid}`} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm text-white/80">
              {status.running
                ? "Writing the first two-second segment."
                : "Play the H.264 slate here before you send it to Castr."}
            </p>
            <p className="max-w-sm text-xs text-white/45">
              1280×720, 30 fps, 2500 kbps, silent stereo. The burned-in clock
              starts when ffmpeg starts.
            </p>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={refreshSlate} onChange={(event) => setRefreshSlate(event.target.checked)} />
        Auto-refresh the burned-in clock every 10 minutes
      </label>
      {status.running && status.slateAgeSeconds !== null ? (
        <p className="text-xs text-zinc-400">
          Slate age {status.slateAgeSeconds}s.
          {status.refreshSeconds ? " Auto-refresh is on: the slate restarts at 10 minutes." : " Auto-refresh is off."}
        </p>
      ) : null}
        <p className="text-sm text-red-300">
          ffmpeg is not on PATH. The browser preview still runs.
        </p>
      ) : null}
      {stale ? (
        <p className="text-sm text-zinc-400">
          The form changed after this encode started. Stop and play again to
          burn in the new title or gate.
        </p>
      ) : null}
      {error ? (
        <pre className="max-h-36 overflow-auto rounded-lg bg-black/50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-red-200">
          {error}
        </pre>
      ) : null}
    </section>
  );
}
