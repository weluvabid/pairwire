import test from "node:test";
import assert from "node:assert/strict";
import { PairwireStore } from "../.test-dist/storage/indexed-db.js";

function makeDatabase() {
  return {
    objectStoreNames: { contains: () => true },
    closeCalls: 0,
    close() { this.closeCalls += 1; },
    onversionchange: null,
  };
}

function installIndexedDb(t, open) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else delete globalThis.indexedDB;
  });
}

test("a failed IndexedDB open does not poison later retry attempts", async (t) => {
  let calls = 0;
  let lateDatabase;
  installIndexedDb(t, () => {
    calls += 1;
    const request = { result: null, error: new Error("temporary open failure"), onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    if (calls === 1) queueMicrotask(() => request.onerror?.());
    else {
      lateDatabase = makeDatabase();
      request.result = lateDatabase;
      queueMicrotask(() => request.onsuccess?.());
    }
    return request;
  });

  const store = new PairwireStore();
  await assert.rejects(store.openDatabase(), /Could not open local message storage/);
  const database = await store.openDatabase();
  assert.equal(database, lateDatabase);
  assert.equal(calls, 2);
});

test("a blocked open that later succeeds closes its orphaned database handle", async (t) => {
  let request;
  const database = makeDatabase();
  installIndexedDb(t, () => {
    request = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    queueMicrotask(() => request.onblocked?.());
    return request;
  });

  const store = new PairwireStore();
  await assert.rejects(store.openDatabase(), /blocked by another tab/);
  request.onsuccess();
  assert.equal(database.closeCalls, 1);
});
