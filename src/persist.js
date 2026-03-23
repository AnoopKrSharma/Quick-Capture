const DB_NAME = "quick-capture-db";
const DB_VERSION = 1;
const STORE = "shots";

const SESSION_KEY = "quickCaptureSession";
const DEFAULT_SESSION = { active: false, fileType: "word" };

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome?.storage?.local;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Single store keeps capture records for the active session.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

export function getSession() {
  // Popup can be opened outside extension context while developing.
  if (!hasChromeStorage()) {
    return Promise.resolve(DEFAULT_SESSION);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([SESSION_KEY], (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve(DEFAULT_SESSION);
        return;
      }
      resolve(res?.[SESSION_KEY] || DEFAULT_SESSION);
    });
  });
}

export function setSession(nextSession) {
  if (!hasChromeStorage()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [SESSION_KEY]: nextSession }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

export async function addShot(shot) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  // Store screenshot + URL; timestamp helps debugging and ordering.
  tx.objectStore(STORE).add({ ...shot, createdAt: Date.now() });
  await txDone(tx);
  db.close();
}

export async function getAllShots() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const req = store.getAll();
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("Failed to read shots"));
  });
  await txDone(tx);
  db.close();
  return rows.map((r) => {
    // Backward compatibility for older saved items that only had dataUrl.
    if (typeof r === "string") {
      return { dataUrl: r, pageUrl: "URL unavailable" };
    }
    if (r?.dataUrl && !r?.pageUrl) {
      return { dataUrl: r.dataUrl, pageUrl: "URL unavailable" };
    }
    return r;
  });
}

export async function getShotCount() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const req = store.count();
  const count = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error || new Error("Failed to count shots"));
  });
  await txDone(tx);
  db.close();
  return count;
}

export async function clearShots() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  // Reset on End or when starting a fresh capture session.
  tx.objectStore(STORE).clear();
  await txDone(tx);
  db.close();
}

