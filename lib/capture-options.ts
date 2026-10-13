/** Capture bitrate choices (kbps, video). The middle one is the default. Shared by the desk and the API. */
export const CAPTURE_BITRATES = {
  "1280x720": [1500, 2500, 4000],
  "1920x1080": [3000, 4500, 6000],
} as const satisfies Record<string, readonly number[]>
