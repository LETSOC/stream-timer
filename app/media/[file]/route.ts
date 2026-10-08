import fs from "node:fs";
import path from "node:path";
import { connection } from "next/server";
import { HLS_DIR } from "@/lib/encoder";

const FILE_NAME = /^(stream\.m3u8|seg-\d+\.ts)$/;

export async function GET(
  _request: Request,
  context: RouteContext<"/media/[file]">,
) {
  await connection();
  const { file } = await context.params;
  if (!FILE_NAME.test(file)) {
    return new Response("Not found", { status: 404 });
  }

  const full = path.resolve(HLS_DIR, file);
  if (!full.startsWith(`${path.resolve(HLS_DIR)}${path.sep}`)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const data = new Uint8Array(fs.readFileSync(full));
    const type = file.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";
    return new Response(data, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
