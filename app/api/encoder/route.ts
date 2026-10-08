import { connection } from "next/server";
import { parseStartInput, readStatus, startEncoder, stopEncoder } from "@/lib/encoder";

export async function GET() {
  await connection();
  return Response.json(readStatus());
}

export async function POST(request: Request) {
  await connection();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const input = parseStartInput(body);
  if (!input) {
    return Response.json(
      { error: "Set a title, date line, and unix start time before encoding." },
      { status: 400 },
    );
  }

  const result = await startEncoder(input);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(readStatus());
}

export async function DELETE() {
  await connection();
  stopEncoder();
  return Response.json(readStatus());
}
