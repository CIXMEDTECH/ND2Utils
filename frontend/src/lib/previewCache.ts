/**
 * Local cache of workspace previews (the 8-bit display channels the server prepares at import).
 *
 * Three layers, fastest first:
 * - memory: a few decoded previews, so stepping back and forth through a folder is instant;
 * - IndexedDB: the compressed previews, kept across reloads up to the administrator's size limit
 *   (least recently viewed are dropped first);
 * - network.
 *
 * Entries are keyed by file id and checked against the file's cache version (`prepared_at`), so a
 * rebuilt cache replaces old copies on the next view. Administrators turn the IndexedDB layer and
 * the background download of every preview ("auto") on or off in Settings → Performance.
 * IndexedDB works on plain-http LAN deployments, where the Cache API is unavailable.
 */
import { clientSettings, parseError } from "./api";
import { readPref, writePref } from "./storage";
import type { FileSummary } from "./types";

export type CachedFile = Pick<FileSummary, "id" | "prepare" | "prepared_at">;

interface Meta {
  id: string;
  version: number;
  size: number;
  used: number;
}

interface Config {
  enabled: boolean;
  auto: boolean;
  limit: number;
}

const DB_NAME = "nd2utils-previews";
const META = "meta";
const DATA = "data";
const OWNER_KEY = "nd2utils.previewCacheOwner";
const MEMORY_LIMIT = 8;
const TOUCH_EVERY_MS = 60_000;
const WARM_CONCURRENCY = 2;

const canGunzip = typeof DecompressionStream !== "undefined";

let config: Config = { enabled: false, auto: false, limit: 0 };
let configured: Promise<void> = Promise.resolve();
let dbPromise: Promise<IDBDatabase | null> | null = null;
/** Mirror of the meta store (small), loaded once. */
let index: Map<string, Meta> | null = null;
let indexPromise: Promise<Map<string, Meta>> | null = null;
const memory = new Map<string, { version: number; buffer: Promise<ArrayBuffer> }>();
const listeners = new Set<() => void>();

const versionOf = (file: CachedFile) => Number(file.prepared_at) || 0;
// Only files whose preparation finished have a stable version worth storing.
const storable = (file: CachedFile) => config.enabled && file.prepare === "ready" && versionOf(file) > 0;

function emit() {
  for (const listener of listeners) listener();
}

/** Notified whenever the stored set or the background download changes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- IndexedDB ---------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: "id" });
        req.result.createObjectStore(DATA);
      };
      req.onsuccess = () => resolve(req.result);
      // Blocked or refused site storage (some private modes): run without the local layer.
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function loadIndex(): Promise<Map<string, Meta>> {
  if (index) return index;
  indexPromise ??= (async () => {
    const db = await openDb();
    const map = new Map<string, Meta>();
    if (db) {
      try {
        const rows = await request(db.transaction(META).objectStore(META).getAll() as IDBRequest<Meta[]>);
        for (const row of rows) map.set(row.id, row);
      } catch {
        // unreadable: start empty
      }
    }
    index = map;
    return map;
  })();
  return indexPromise;
}

async function removeStored(ids: string[]): Promise<void> {
  const [db, map] = await Promise.all([openDb(), loadIndex()]);
  const present = ids.filter((id) => map.has(id));
  if (!db || !present.length) return;
  const tx = db.transaction([META, DATA], "readwrite");
  for (const id of present) {
    tx.objectStore(META).delete(id);
    tx.objectStore(DATA).delete(id);
    map.delete(id);
  }
  await done(tx).catch(() => undefined);
  emit();
}

function storedBytes(map: Map<string, Meta>): number {
  let total = 0;
  for (const meta of map.values()) total += meta.size;
  return total;
}

/** Store `gz` (compressed preview). Viewed previews make room by dropping the least recently
 * viewed; background downloads (`evict = false`) never push anything out. */
async function store(file: CachedFile, gz: ArrayBuffer, evict: boolean): Promise<boolean> {
  const [db, map] = await Promise.all([openDb(), loadIndex()]);
  if (!db || !config.enabled || gz.byteLength > config.limit) return false;
  const current = map.get(file.id);
  let total = storedBytes(map) - (current?.size ?? 0);
  const drop: string[] = [];
  if (total + gz.byteLength > config.limit) {
    if (!evict) return false;
    const oldest = [...map.values()].filter((m) => m.id !== file.id).sort((a, b) => a.used - b.used);
    for (const meta of oldest) {
      if (total + gz.byteLength <= config.limit) break;
      drop.push(meta.id);
      total -= meta.size;
    }
  }
  const meta: Meta = { id: file.id, version: versionOf(file), size: gz.byteLength, used: Date.now() };
  try {
    const tx = db.transaction([META, DATA], "readwrite");
    for (const id of drop) {
      tx.objectStore(META).delete(id);
      tx.objectStore(DATA).delete(id);
    }
    tx.objectStore(META).put(meta);
    tx.objectStore(DATA).put(gz, file.id);
    await done(tx);
  } catch {
    // Quota exceeded or storage cleared underneath us: the preview just is not kept.
    return false;
  }
  for (const id of drop) map.delete(id);
  map.set(file.id, meta);
  emit();
  return true;
}

async function readStored(file: CachedFile): Promise<ArrayBuffer | null> {
  const map = await loadIndex();
  const meta = map.get(file.id);
  // An older version is simply overwritten by the download that follows.
  if (!meta || meta.version !== versionOf(file)) return null;
  const db = await openDb();
  if (!db) return null;
  try {
    const gz = await request(db.transaction(DATA).objectStore(DATA).get(file.id) as IDBRequest<ArrayBuffer | undefined>);
    if (!gz) return null;
    if (Date.now() - meta.used > TOUCH_EVERY_MS) {
      meta.used = Date.now();
      db.transaction(META, "readwrite").objectStore(META).put(meta);
    }
    return gz;
  } catch {
    return null;
  }
}

// --- network -------------------------------------------------------------------------

/** The server is still preparing this file's preview (it was moved to the front of its queue). */
export class PreviewPending extends Error {
  constructor(id: string) {
    super(`preview of ${id} is being prepared`);
    this.name = "PreviewPending";
  }
}

export const isPending = (err: unknown): err is PreviewPending => err instanceof PreviewPending;

function gunzip(gz: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

async function download(id: string, compressed: boolean, version = 0): Promise<ArrayBuffer> {
  const qs = new URLSearchParams();
  if (compressed) qs.set("wire", "gzip");
  if (version) qs.set("v", String(version));
  const query = qs.toString();
  const res = await fetch(`/api/files/${id}/display${query ? `?${query}` : ""}`);
  if (res.status === 202) throw new PreviewPending(id);
  if (!res.ok) throw await parseError(res);
  return res.arrayBuffer();
}

async function load(file: CachedFile): Promise<ArrayBuffer> {
  await configured;
  const ver = versionOf(file);
  if (storable(file) && canGunzip) {
    const stored = await readStored(file);
    if (stored) return gunzip(stored);
    const gz = await download(file.id, true, ver);
    void store(file, gz, true);
    return gunzip(gz);
  }
  return download(file.id, false, ver);
}

/**
 * Decoded preview (packed 8-bit planes, see unpackPlane) of a file, from the fastest layer that
 * has the current version.
 */
export function getDisplay(file: CachedFile): Promise<ArrayBuffer> {
  const version = versionOf(file);
  const hit = memory.get(file.id);
  if (hit && hit.version === version) {
    memory.delete(file.id);
    memory.set(file.id, hit);
    return hit.buffer;
  }
  const buffer = load(file);
  memory.set(file.id, { version, buffer });
  buffer.catch(() => {
    if (memory.get(file.id)?.buffer === buffer) memory.delete(file.id);
  });
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  return buffer;
}

/** Decode these previews into memory ahead of time (the neighbours of the selected file). */
export function prefetch(files: CachedFile[]) {
  for (const file of files) void getDisplay(file).catch(() => undefined);
}

// --- background download ("auto") -----------------------------------------------------

let warmQueue: CachedFile[] = [];
let warmRunning = 0;
/** Downloads finished / in flight in the current background batch (progress display). */
let warmDone = 0;
let warmInflight = 0;

/** Progress of the background download, or null when idle. */
export function warmProgress(): { done: number; total: number } | null {
  const total = warmDone + warmInflight + warmQueue.length;
  return total ? { done: warmDone, total } : null;
}

async function warmNext(): Promise<void> {
  while (warmQueue.length && config.enabled && config.auto) {
    const file = warmQueue.shift()!;
    const map = await loadIndex();
    if (map.get(file.id)?.version === versionOf(file) || memory.get(file.id)?.version === versionOf(file)) continue;
    warmInflight += 1;
    try {
      const gz = await download(file.id, true, versionOf(file));
      // Full: stop instead of replacing previews the user actually looked at.
      if (!(await store(file, gz, false))) warmQueue = [];
    } catch {
      // Deleted meanwhile, network hiccup…: the file is fetched when it is opened.
    } finally {
      warmInflight -= 1;
      warmDone += 1;
      if (!warmQueue.length && !warmInflight) warmDone = 0;
      emit();
    }
  }
}

/**
 * Download every listed preview that is not stored yet, a couple at a time, in list order.
 * A new call replaces the pending list. No-op unless the administrator enabled it.
 */
export function warm(files: CachedFile[]) {
  void configured.then(async () => {
    if (!config.enabled || !config.auto || !canGunzip) return;
    const map = await loadIndex();
    // Previews in memory were (or are being) stored by the view that loaded them.
    const pending = (f: CachedFile) => map.get(f.id)?.version !== versionOf(f) && memory.get(f.id)?.version !== versionOf(f);
    warmQueue = files.filter((f) => storable(f) && pending(f));
    if (!warmQueue.length && !warmInflight) warmDone = 0;
    emit();
    while (warmRunning < WARM_CONCURRENCY && warmQueue.length) {
      warmRunning += 1;
      void warmNext().finally(() => {
        warmRunning -= 1;
      });
    }
  });
}

// --- management ------------------------------------------------------------------------

/** Forget these files everywhere (their cache is being rebuilt). */
export function forget(ids: string[]) {
  for (const id of ids) memory.delete(id);
  warmQueue = warmQueue.filter((f) => !ids.includes(f.id));
  void removeStored(ids);
  emit();
}

/** Remove every stored preview (sign-out, user request, or the administrator turned it off). */
export async function clearLocal(): Promise<void> {
  memory.clear();
  warmQueue = [];
  warmDone = 0;
  const db = await openDb();
  if (db) {
    const tx = db.transaction([META, DATA], "readwrite");
    tx.objectStore(META).clear();
    tx.objectStore(DATA).clear();
    await done(tx).catch(() => undefined);
  }
  index = new Map();
  indexPromise = null;
  emit();
}

export async function usage(): Promise<{ count: number; bytes: number }> {
  const map = await loadIndex();
  return { count: map.size, bytes: storedBytes(map) };
}

/**
 * Apply the server's cache settings for the signed-in workspace. Previews of another workspace
 * (a different access code used in this browser) are removed first.
 */
export function configure(ownerId: string | null, refresh = false): Promise<void> {
  configured = (async () => {
    if (!ownerId) {
      config = { enabled: false, auto: false, limit: 0 };
      return;
    }
    if (readPref(OWNER_KEY) !== ownerId) {
      await clearLocal();
      writePref(OWNER_KEY, ownerId);
    }
    try {
      const s = await clientSettings(refresh);
      config = { enabled: s.local_cache, auto: s.local_cache_auto, limit: s.local_cache_bytes };
    } catch {
      config = { enabled: false, auto: false, limit: 0 };
    }
    if (!config.enabled) {
      await clearLocal();
      return;
    }
    // A lower limit than before: trim the least recently viewed.
    const map = await loadIndex();
    let total = storedBytes(map);
    if (total > config.limit) {
      const drop: string[] = [];
      for (const meta of [...map.values()].sort((a, b) => a.used - b.used)) {
        if (total <= config.limit) break;
        drop.push(meta.id);
        total -= meta.size;
      }
      await removeStored(drop);
    }
  })();
  emit();
  return configured;
}

/** Sign-out: nothing of the workspace stays in this browser. */
export async function signedOut(): Promise<void> {
  await configure(null);
  await clearLocal();
  writePref(OWNER_KEY, "");
}
