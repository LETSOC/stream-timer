import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_EVENT } from "@/lib/event"
import { publicState, readServerState, writeServerEvent } from "@/lib/event-server"
import { parseStage } from "@/lib/stage"

// event-server reads STREAM_DATA_DIR on every call.
process.env.STREAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scene-text-"))

// Real save path used by PUT /api/event: writeServerEvent → parseStage → event.json → readServerState / publicState.
