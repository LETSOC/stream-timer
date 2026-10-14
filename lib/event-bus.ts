import { EventEmitter } from "node:events"

/**
 * In-process "event.json was saved" bus. Next bundles route handlers separately from server.ts,
 * so the emitter lives on globalThis under a registry symbol: every copy of this module in the
 * process (Next's bundle, tsx-loaded server.ts) shares one instance.
 */
const KEY = Symbol.for("stream-timer.event-bus")
type Holder = { [KEY]?: EventEmitter }

export function eventBus(): EventEmitter {
  const holder = globalThis as Holder
  if (!holder[KEY]) {
    const bus = new EventEmitter()
    bus.setMaxListeners(0)
    holder[KEY] = bus
  }
  return holder[KEY]
}

export function emitSaved(rev: number) {
  eventBus().emit("saved", rev)
}

export function onSaved(listener: (rev: number) => void): () => void {
  const bus = eventBus()
  bus.on("saved", listener)
  return () => bus.off("saved", listener)
}
