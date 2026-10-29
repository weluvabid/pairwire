import type {
  ChatMessage,
  ConversationRecord,
  MessageStatus,
  PeerRecord,
  SettingsRecord,
} from "../core/types.js";
import { transitionMessage } from "../core/message-state.js";

const DATABASE_NAME = "pairwire";
const DATABASE_VERSION = 1;
const STORES = {
  settings: "settings",
  peers: "peers",
  conversations: "conversations",
  messages: "messages",
  outbox: "outbox",
} as const;

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class PairwireStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async getOrCreateDeviceId(): Promise<string> {
    return this.withOneStore(STORES.settings, "readwrite", async (store) => {
      const existing = await requestResult(store.get("deviceId") as IDBRequest<SettingsRecord | undefined>);
      if (existing?.value) return existing.value;
      const id = crypto.randomUUID();
      await requestResult(store.put({ key: "deviceId", value: id } satisfies SettingsRecord));
      return id;
    });
  }

  async getDisplayName(): Promise<string> {
    return (await this.getSetting("displayName")) ?? "You";
  }

  async setDisplayName(name: string): Promise<void> {
    const normalized = name.trim().slice(0, 48) || "You";
    await this.setSetting("displayName", normalized);
  }

  async getPeers(): Promise<PeerRecord[]> {
    return this.withOneStore(STORES.peers, "readonly", (store) => requestResult(store.getAll() as IDBRequest<PeerRecord[]>));
  }

  async savePeer(peer: PeerRecord): Promise<void> {
    await this.withOneStore(STORES.peers, "readwrite", async (store) => {
      await requestResult(store.put(peer));
    });
    await this.upsertConversation({ id: peer.conversationId, peerId: peer.id, updatedAt: peer.lastSeenAt });
  }

  async getConversations(): Promise<ConversationRecord[]> {
    return this.withOneStore(STORES.conversations, "readonly", (store) =>
      requestResult(store.getAll() as IDBRequest<ConversationRecord[]>),
    );
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.withOneStore(STORES.messages, "readonly", (store) =>
      requestResult(store.index("byConversation").getAll(conversationId) as IDBRequest<ChatMessage[]>),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async createOutgoing(message: ChatMessage): Promise<void> {
    try {
      await this.withStores([STORES.messages, STORES.outbox, STORES.conversations], "readwrite", async (stores) => {
        const messages = stores[STORES.messages];
        const outbox = stores[STORES.outbox];
        const conversations = stores[STORES.conversations];
        if (!messages || !outbox || !conversations) throw new StorageError("Storage schema is incomplete.");
        await requestResult(messages.add(message));
        await requestResult(outbox.put(message));
        const previous = await requestResult(conversations.get(message.conversationId) as IDBRequest<ConversationRecord | undefined>);
        await requestResult(conversations.put({
          ...previous,
          id: message.conversationId,
          peerId: message.toPeerId,
          updatedAt: message.createdAt,
          lastMessage: message.text,
        }));
      });
    } catch (error) {
      throw wrapStorageError("Could not save outgoing message.", error);
    }
  }

  async commitIncoming(message: ChatMessage): Promise<{ inserted: boolean; message: ChatMessage }> {
    try {
      return await this.withStores([STORES.messages, STORES.conversations], "readwrite", async (stores) => {
        const messages = stores[STORES.messages];
        const conversations = stores[STORES.conversations];
        if (!messages || !conversations) throw new StorageError("Storage schema is incomplete.");
        const existing = await requestResult(messages.get(message.id) as IDBRequest<ChatMessage | undefined>);
        if (existing) return { inserted: false, message: existing };
        await requestResult(messages.add(message));
        const previous = await requestResult(conversations.get(message.conversationId) as IDBRequest<ConversationRecord | undefined>);
        await requestResult(conversations.put({
          ...previous,
          id: message.conversationId,
          peerId: message.fromPeerId,
          updatedAt: message.createdAt,
          lastMessage: message.text,
        }));
        return { inserted: true, message };
      });
    } catch (error) {
      throw wrapStorageError("Could not persist incoming message.", error);
    }
  }

  async setMessageStatus(id: string, nextStatus: MessageStatus): Promise<ChatMessage | undefined> {
    try {
      return await this.withStores([STORES.messages, STORES.outbox], "readwrite", async (stores) => {
        const messages = stores[STORES.messages];
        const outbox = stores[STORES.outbox];
        if (!messages || !outbox) throw new StorageError("Storage schema is incomplete.");
        const current = await requestResult(messages.get(id) as IDBRequest<ChatMessage | undefined>);
        if (!current) return undefined;
        if (current.status === "delivered") return current;
        const status = transitionMessage(current.status, nextStatus);
        const updated = { ...current, status };
        await requestResult(messages.put(updated));
        if (status === "delivered") await requestResult(outbox.delete(id));
        else await requestResult(outbox.put(updated));
        return updated;
      });
    } catch (error) {
      throw wrapStorageError(`Could not update message ${id}.`, error);
    }
  }

  async retryMessage(id: string): Promise<ChatMessage | undefined> {
    return this.setMessageStatus(id, "pending");
  }

  async getOutbox(): Promise<ChatMessage[]> {
    const rows = await this.withOneStore(STORES.outbox, "readonly", (store) =>
      requestResult(store.getAll() as IDBRequest<ChatMessage[]>),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async recoverOutboxAfterRestart(): Promise<void> {
    await this.withStores([STORES.messages, STORES.outbox], "readwrite", async (stores) => {
      const messages = stores[STORES.messages];
      const outbox = stores[STORES.outbox];
      if (!messages || !outbox) throw new StorageError("Storage schema is incomplete.");
      const queued = await requestResult(outbox.getAll() as IDBRequest<ChatMessage[]>);
      for (const message of queued) {
        if (message.status !== "sending" && message.status !== "sent") continue;
        const recovered = { ...message, status: "pending" as const };
        await requestResult(messages.put(recovered));
        await requestResult(outbox.put(recovered));
      }
    });
  }

  private async getSetting(key: string): Promise<string | undefined> {
    const row = await this.withOneStore(STORES.settings, "readonly", (store) =>
      requestResult(store.get(key) as IDBRequest<SettingsRecord | undefined>),
    );
    return row?.value;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.withOneStore(STORES.settings, "readwrite", async (store) => {
      await requestResult(store.put({ key, value } satisfies SettingsRecord));
    });
  }

  private async upsertConversation(conversation: ConversationRecord): Promise<void> {
    await this.withOneStore(STORES.conversations, "readwrite", async (store) => {
      const current = await requestResult(store.get(conversation.id) as IDBRequest<ConversationRecord | undefined>);
      await requestResult(store.put({ ...current, ...conversation }));
    });
  }

  private async withOneStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.openDatabase();
    const transaction = db.transaction(storeName, mode);
    const done = transactionDone(transaction);
    try {
      const result = await operation(transaction.objectStore(storeName));
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
      try { await done; } catch { /* Preserve the operation error. */ }
      throw error;
    }
  }

  private async withStores<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    operation: (stores: Record<string, IDBObjectStore>) => Promise<T>,
  ): Promise<T> {
    const db = await this.openDatabase();
    const transaction = db.transaction(storeNames, mode);
    const done = transactionDone(transaction);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of storeNames) stores[name] = transaction.objectStore(name);
    try {
      const result = await operation(stores);
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
      try { await done; } catch { /* Preserve the operation error. */ }
      throw error;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.settings)) {
          db.createObjectStore(STORES.settings, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.peers)) {
          db.createObjectStore(STORES.peers, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.conversations)) {
          db.createObjectStore(STORES.conversations, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.messages)) {
          const messages = db.createObjectStore(STORES.messages, { keyPath: "id" });
          messages.createIndex("byConversation", "conversationId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.outbox)) {
          db.createObjectStore(STORES.outbox, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.databasePromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(wrapStorageError("Could not open local message storage.", request.error));
      request.onblocked = () => reject(new StorageError("Storage upgrade is blocked by another tab."));
    });
    return this.databasePromise;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new StorageError("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new StorageError("Transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new StorageError("Transaction failed."));
  });
}

function wrapStorageError(message: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(message, error instanceof Error ? { cause: error } : undefined);
}
