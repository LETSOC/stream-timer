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
  rtmpState: "stopped" | "starting" | "connected" | "reconnecting" | "stalled" | "failed"
  /** Set when the last stop had to SIGKILL, or could not kill at all. */
  stopNote: string | null
  rtmpRunning: boolean
  /** The supervisor is waiting to relaunch ffmpeg after it exited. */
  rtmpReconnecting: boolean
  /** How many times the supervisor has relaunched ffmpeg since Start stream. */
  rtmpRestarts: number
  /** True when this server re-attached to a stream it found running (e.g. after a restart). */
  rtmpAdopted: boolean
  /** What the running RTMP stream is publishing: the drawtext slate or a browser capture of /stream. */
  rtmpSource: "slate" | "capture" | null
  /** How many of this project's supervisors are running; more than 1 needs "Stop all". */
  rtmpOwnProcesses: number
  /** Why the latest run failed to connect, e.g. "Can't connect to ingest (host): End of file". */
  rtmpConnectError: string | null
  /** Last give-up reason after the stream stopped (bad URL, too many quick failures). */
  rtmpFailure: string | null
  rtmpLogTail: string
  /** Other ffmpeg processes publishing over RTMP that this app did not start. */
  strayPublishers: { pid: number; command: string }[]
}
