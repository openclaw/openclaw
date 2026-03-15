/**
 * Encrypted localStorage wrapper using Web Crypto API.
 *
 * Provides AES-GCM encryption for sensitive values stored in the browser.
 * The encryption key is a non-extractable CryptoKey generated once and
 * persisted in IndexedDB, so it survives page reloads but never leaves
 * the browser's crypto sandbox.
 *
 * Graceful migration: if a value was stored before encryption was enabled
 * (i.e. it does NOT carry the "enc:" prefix), it is returned as-is and
 * will be re-encrypted on the next write.
 *
 * If decryption of an "enc:"-prefixed value fails (corrupt data, key
 * rotation, etc.), the entry is treated as lost and null is returned
 * rather than leaking ciphertext to callers.
 */

const DB_NAME = "openclaw-secure-storage";
const DB_STORE = "keys";
const DB_KEY_ID = "master";
const KEY_ALGO = "AES-GCM";
const KEY_LENGTH = 256;

// ---------------------------------------------------------------------------
// Base64 helpers – safe for arbitrarily large buffers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Process 8 KiB at a time to avoid exceeding the max call-stack size
  // that `String.fromCharCode(...spread)` hits at ~48 KiB.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    let binary = "";
    for (let j = 0; j < slice.length; j++) {
      binary += String.fromCharCode(slice[j]);
    }
    chunks.push(binary);
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IndexedDB key persistence
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: KEY_ALGO, length: KEY_LENGTH },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) {
    return cachedKey;
  }

  const db = await openDb();
  try {
    const existing = await idbGet(db, DB_KEY_ID);
    if (existing) {
      cachedKey = existing;
      return existing;
    }
    const key = await generateKey();
    await idbPut(db, DB_KEY_ID, key);
    cachedKey = key;
    return key;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: KEY_ALGO, iv }, key, encoded);
  const ivB64 = bytesToBase64(iv);
  const ctB64 = bytesToBase64(new Uint8Array(ciphertext));
  return `enc:${ivB64}.${ctB64}`;
}

async function decrypt(stored: string): Promise<string> {
  if (!stored.startsWith("enc:")) {
    // Not encrypted – return raw value (migration path for legacy data)
    return stored;
  }
  const key = await getKey();
  const payload = stored.slice(4);
  const dotIdx = payload.indexOf(".");
  if (dotIdx === -1) {
    throw new Error("malformed encrypted value");
  }
  const ivB64 = payload.slice(0, dotIdx);
  const ctB64 = payload.slice(dotIdx + 1);
  if (!ivB64 || !ctB64) {
    throw new Error("malformed encrypted value");
  }
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ctB64);
  const plainBuffer = await crypto.subtle.decrypt({ name: KEY_ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuffer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a value encrypted in localStorage.
 */
export async function secureSet(key: string, value: string): Promise<void> {
  const encrypted = await encrypt(value);
  localStorage.setItem(key, encrypted);
}

/**
 * Read and decrypt a value from localStorage.
 *
 * Returns `null` when:
 * - the key doesn't exist, or
 * - an `enc:`-prefixed value cannot be decrypted (corrupt / key mismatch).
 *
 * Returns the raw plaintext for legacy (non-`enc:`) values so the caller
 * can transparently re-encrypt on the next write.
 */
export async function secureGet(key: string): Promise<string | null> {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    return null;
  }
  try {
    return await decrypt(raw);
  } catch {
    // If the stored value carries the enc: prefix, decryption genuinely
    // failed (corrupt data, key rotation, etc.) – treat as lost rather
    // than leaking ciphertext to the caller.
    if (raw.startsWith("enc:")) {
      return null;
    }
    // No enc: prefix → legacy unencrypted value (migration path)
    return raw;
  }
}

/**
 * Remove a value from localStorage.
 */
export function secureRemove(key: string): void {
  localStorage.removeItem(key);
}

// ---------------------------------------------------------------------------
// Testing utilities – only used by test suites
// ---------------------------------------------------------------------------

/**
 * Reset the cached key so each test gets a fresh key from IndexedDB.
 * **Test-only** – never call in production code.
 */
export function __resetForTesting(): void {
  cachedKey = null;
}
