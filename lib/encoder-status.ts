export type EncoderStatus = {
  running: boolean;
  playlistReady: boolean;
  pid: number | null;
  logTail: string;
  ffmpeg: boolean;
  eventName: string | null;
  dateLine: string | null;
  targetUnix: number | null;
};
