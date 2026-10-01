/**
 * Pure logic for telegram-mcp. No grammy, no MCP SDK, no I/O: everything that
 * touches the network is injected, so it can be unit tested with node --test.
 */

export const DEFAULT_TIMEOUT_S = 300;
export const MIN_TIMEOUT_S = 10;
export const MAX_TIMEOUT_S = 3600;
export const TELEGRAM_LIMIT = 4096;

// ── Timeout ───────────────────────────────────────────────────────────────────

/** Clamp a user supplied timeout (seconds) to 10..3600. Missing/invalid -> 300. */
export function clampTimeout(value, def = DEFAULT_TIMEOUT_S) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) return def;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(n)));
}

export function timeoutMessage(seconds) {
  return `Timed out after ${seconds}s`;
}

// ── Message splitting ─────────────────────────────────────────────────────────

/**
 * Split text into chunks of at most `limit` chars. Prefers to break at a
 * paragraph, then a line, then a space; hard-cuts only when none is found.
 * Never splits a surrogate pair. Chunks joined back (modulo trimmed break
 * whitespace) contain all of the text.
 */
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = limit;
    const window = rest.slice(0, limit);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const floor = Math.floor(limit / 2);
    if (para >= floor) cut = para;
    else if (line >= floor) cut = line;
    else if (space >= floor) cut = space;
    else {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // do not split a pair
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/** Truncate to `limit` chars, ending with an ellipsis when cut. */
export function truncate(text, limit = TELEGRAM_LIMIT) {
  const s = String(text);
  if (s.length <= limit) return s;
  let cut = limit - 3;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + "...";
}

// ── Callback data ─────────────────────────────────────────────────────────────
// Telegram limits callback_data to 64 bytes, so we send indexes, not text:
//   b:<batchId>:<itemIndex>:<optionIndex>   (choose_batch)
//   c:<chooseId>:<optionIndex>              (choose)

export function encodeBatchCb(batchId, itemIdx, optIdx) {
  return `b:${batchId}:${itemIdx}:${optIdx}`;
}

export function decodeBatchCb(data) {
  const m = /^b:([0-9a-f]{1,16}):(\d{1,3}):(\d{1,3})$/.exec(String(data));
  if (!m) return null;
  return { batchId: m[1], itemIdx: Number(m[2]), optIdx: Number(m[3]) };
}

export function encodeChooseCb(chooseId, optIdx) {
  return `c:${chooseId}:${optIdx}`;
}

export function decodeChooseCb(data) {
  const m = /^c:([0-9a-f]{1,16}):(\d{1,3})$/.exec(String(data));
  if (!m) return null;
  return { chooseId: m[1], optIdx: Number(m[2]) };
}

// ── Batch tracking ────────────────────────────────────────────────────────────

export class BatchTracker {
  /** items: [{id, text, options}] */
  constructor(batchId, items) {
    this.batchId = batchId;
    this.items = items;
    this.answers = new Map(); // id -> option
  }

  /**
   * Feed one callback_data string. Returns
   *   {type: "answered", id, option, itemIdx}
   *   {type: "ignored", reason: "foreign" | "unknown" | "duplicate"}
   * "foreign" = not ours (other batch or not a batch callback).
   */
  handle(data) {
    const d = decodeBatchCb(data);
    if (!d || d.batchId !== this.batchId) return { type: "ignored", reason: "foreign" };
    const item = this.items[d.itemIdx];
    if (!item || d.optIdx >= item.options.length) {
      return { type: "ignored", reason: "unknown" };
    }
    if (this.answers.has(item.id)) return { type: "ignored", reason: "duplicate" };
    const option = item.options[d.optIdx];
    this.answers.set(item.id, option);
    return { type: "answered", id: item.id, option, itemIdx: d.itemIdx };
  }

  get complete() {
    return this.answers.size === this.items.length;
  }

  /** {answers: {id: option|null}, timed_out: [ids]} in item order. */
  result() {
    const answers = {};
    const timed_out = [];
    for (const it of this.items) {
      if (this.answers.has(it.id)) answers[it.id] = this.answers.get(it.id);
      else {
        answers[it.id] = null;
        timed_out.push(it.id);
      }
    }
    return { answers, timed_out };
  }
}

/** Returns an error string if the batch items are invalid, else null. */
export function validateBatchItems(items) {
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) return `duplicate item id: ${it.id}`;
    seen.add(it.id);
  }
  return null;
}

// ── Lazy polling ──────────────────────────────────────────────────────────────

export class PollingConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "PollingConflictError";
  }
}

export function describePollingError(err) {
  const code = err?.error_code ?? err?.error?.error_code;
  const text = String(err?.message ?? err);
  if (code === 409 || /\b409\b|conflict/i.test(text)) {
    return "another session is polling this bot (Telegram 409 conflict). Only one session can wait for replies at a time; retry when the other session finishes waiting.";
  }
  return `polling failed: ${text}`;
}

/**
 * Reference-counted polling. `startPolling()` must return
 * `{ stop: () => Promise|void, done: Promise }` where `done` rejects if polling
 * dies (for example a 409) and resolves when stopped normally.
 *
 * acquire() -> { failed, release }.
 *   failed: a promise that rejects with PollingConflictError if polling dies
 *           while this handle is held (race your wait against it).
 *   release(): idempotent; polling stops when the last handle is released.
 */
export class PollingController {
  constructor({ startPolling, log = () => {} }) {
    this.startPolling = startPolling;
    this.log = log;
    this.handles = new Set();
    this.run = null;
  }

  get active() {
    return this.run !== null;
  }

  get waiters() {
    return this.handles.size;
  }

  acquire() {
    let rejectFailed;
    const failed = new Promise((_, rej) => (rejectFailed = rej));
    failed.catch(() => {}); // never an unhandled rejection
    const handle = { failed, fail: rejectFailed, released: false };
    handle.release = () => {
      if (handle.released) return;
      handle.released = true;
      this.handles.delete(handle);
      if (this.handles.size === 0) this._stop();
    };
    this.handles.add(handle);
    try {
      if (!this.run) this._start();
    } catch (err) {
      this.handles.delete(handle);
      handle.released = true;
      handle.fail(new PollingConflictError(describePollingError(err)));
    }
    return handle;
  }

  _start() {
    const run = this.startPolling();
    this.run = run;
    this.log("polling started");
    Promise.resolve(run.done).then(
      () => {
        if (this.run === run) this.run = null;
      },
      (err) => {
        if (this.run !== run) return; // stopped on purpose, ignore
        this.run = null;
        const e = new PollingConflictError(describePollingError(err));
        const hs = [...this.handles];
        this.handles.clear();
        for (const h of hs) {
          h.released = true;
          h.fail(e);
        }
      },
    );
  }

  _stop() {
    const run = this.run;
    this.run = null;
    if (!run) return;
    this.log("polling stopped");
    try {
      const p = run.stop();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // stopping a dead poller is fine
    }
  }
}
