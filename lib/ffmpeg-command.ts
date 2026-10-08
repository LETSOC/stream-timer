import { escapeDrawtext } from "@/lib/countdown"

type FfmpegCommandInput = {
  eventName: string
  dateLine: string
  targetUnix: number
  rtmpUrl: string
}

export function buildStreamShellCommand(input: FfmpegCommandInput): string {
  const rtmp = input.rtmpUrl.trim() || "rtmp://YOUR_HOST/static/YOUR_STREAM?password=YOUR_PASSWORD"

  return [
    `EVENT_NAME=${shellQuote(input.eventName)} \\`,
    `EVENT_LINE=${shellQuote(input.dateLine)} \\`,
    `TARGET_UNIX=${input.targetUnix} \\`,
    `RTMP_URL=${shellQuote(rtmp)} \\`,
    "./scripts/stream-countdown.sh",
  ].join("\n")
}

export function buildLocalTestCommand(input: Omit<FfmpegCommandInput, "rtmpUrl">): string {
  return [
    `EVENT_NAME=${shellQuote(input.eventName)} \\`,
    `EVENT_LINE=${shellQuote(input.dateLine)} \\`,
    `TARGET_UNIX=${input.targetUnix} \\`,
    "./scripts/stream-countdown.sh --file hyphen-countdown-test.mp4 --duration 6",
  ].join("\n")
}

export function buildInlineFfmpegExample(input: FfmpegCommandInput): string {
  const remaining = Math.max(0, input.targetUnix - Math.floor(Date.now() / 1000))
  const name = escapeDrawtext(input.eventName)
  const line = escapeDrawtext(input.dateLine)
  const rtmp = input.rtmpUrl.trim() || "rtmp://YOUR_HOST/static/YOUR_STREAM?password=YOUR_PASSWORD"

  return `ffmpeg -re \\
-f lavfi -i color=c=0x111111:s=1280x720:r=30 \\
-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \\
-vf "drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=160:text='${name}',\\
drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:fontsize=36:fontcolor=0xaaaaaa:x=(w-text_w)/2:y=230:text='${line}',\\
drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2+50:text='%{eif\\:max(0\\,trunc((${remaining}-t)/86400))\\:d}d %{eif\\:trunc(mod(max(0\\,${remaining}-t)/3600\\,24))\\:d\\:2}h %{eif\\:trunc(mod(max(0\\,${remaining}-t)/60\\,60))\\:d\\:2}m %{eif\\:mod(max(0\\,${remaining}-t)\\,60)\\:d\\:2}s'" \\
-c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -pix_fmt yuv420p \\
-c:a aac -b:a 128k -ar 44100 \\
-f flv ${shellQuote(rtmp)}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
