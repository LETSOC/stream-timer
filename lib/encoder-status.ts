export type EncoderStatus = {
  running: boolean
  playlistReady: boolean
  pid: number | null
  logTail: string
  ffmpeg: boolean
  eventName: string | null
  dateLine: string | null
  targetUnix: number | null
  startedAt: number | null
  slateAgeSeconds: number | null
  burnedRemainingAtStart: number | null
  refreshSeconds: number | null
  /** HLS preview: stopped, starting (no playlist yet), running (playlist advancing), stalled. */
  encoderState: "stopped" | "starting" | "running" | "stalled"
  rtmpState: "stopped" | "starting" | "connected" | "reconnecting" | "failed"
  /** Set when the last stop had to SIGKILL, or could not kill at all. */
  stopNote: string | null
  rtmpRunning: boolean
  /** The supervisor is waiting to relaunch ffmpeg after it exited. */
  rtmpReconnecting: boolean
  /** How many times the supervisor has relaunched ffmpeg since Start stream. */
  rtmpRestarts: number
  rtmpLogTail: string
  /** Other ffmpeg processes publishing over RTMP that this app did not start. */
  strayPublishers: { pid: number; command: string }[]
}
