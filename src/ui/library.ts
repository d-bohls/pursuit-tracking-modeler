// Samples are stored as Float64Arrays, which IndexedDB keeps natively. A run
// is ~440 samples, a few KB, so storage is not a concern for hundreds of runs.

import type { SimulationMode } from './experiment';

/** The numbers a list row shows, stored so the list never re-identifies anything. */
export interface RecordingSummary {
  trials: number;
  /** Trials still in the model; the numbers below are NaN when this is 0. */
  included: number;
  zeta: number;
  wn: number;
  delayMs: number;
}

export interface Recording {
  id: number;
  createdAt: number;
  /** Who tracked: you, or the model during a self-test run. */
  source: SimulationMode;
  /** Set when the recording came from a file rather than from this app. */
  fileName?: string;
  samplePeriodMs: number;
  xs: Float64Array;
  ys: Float64Array;
  /** Trials left out of the model, by index. */
  excluded: number[];
  note: string;
  summary: RecordingSummary | null;
  /** Content hash, so importing the same file twice keeps one copy. */
  hash: string;
}

export type NewRecording = Omit<Recording, 'id'>;

const DB_NAME = 'tracking-lab';
const STORE = 'recordings';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('hash', 'hash');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open would otherwise be cached forever; let the next call retry.
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** A cheap, stable fingerprint of the samples. Collisions only merge identical-looking runs. */
export function hashSamples(xs: Float64Array, ys: Float64Array): string {
  let h = 2166136261 >>> 0; // FNV-1a over the rounded samples
  const mix = (v: number) => {
    const n = Math.round(v * 1000);
    h ^= n & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 16) & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  for (let i = 0; i < xs.length; i++) {
    mix(xs[i]);
    mix(ys[i]);
  }
  return `${xs.length}:${h.toString(16)}`;
}

/** Every recording, newest first. */
export async function listRecordings(): Promise<Recording[]> {
  const all = await request<Recording[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id: number): Promise<Recording | undefined> {
  return request<Recording | undefined>('readonly', (s) => s.get(id));
}

export async function findByHash(hash: string): Promise<Recording | undefined> {
  return request<Recording | undefined>('readonly', (s) => s.index('hash').get(hash));
}

export async function addRecording(rec: NewRecording): Promise<number> {
  return request<IDBValidKey>('readwrite', (s) => s.add(rec)).then((key) => key as number);
}

/** Merges `patch` into a stored recording. A missing id is ignored: it was deleted. */
export async function updateRecording(id: number, patch: Partial<NewRecording>): Promise<void> {
  // Read and write in ONE transaction. Two separate ones let a note edit and
  // a trial toggle landing together each write back a stale copy of the other.
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(id);
    get.onsuccess = () => {
      if (get.result) store.put({ ...get.result, ...patch, id });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteRecording(id: number): Promise<void> {
  await request('readwrite', (s) => s.delete(id));
}
