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
  rtmpRunning: boolean
  /** The supervisor is waiting to relaunch ffmpeg after it exited. */
  rtmpReconnecting: boolean
  /** How many times the supervisor has relaunched ffmpeg since Start stream. */
  rtmpRestarts: number
  rtmpLogTail: string
  /** Other ffmpeg processes publishing over RTMP that this app did not start. */
  strayPublishers: { pid: number; command: string }[]
}
