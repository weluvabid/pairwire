import type {
  ChatMessage,
  ConversationRecord,
  MessageStatus,
  PeerRecord,
  SettingsRecord,
} from '../core/types.js';
import { transitionMessage } from '../core/message-state.js';
import { hasSameMessageIdentity } from '../core/message-identity.js';
import { containsControlCharacters } from '../utils/text-validation.js';

const DATABASE_NAME = 'pairwire';
const DATABASE_VERSION = 1;
const STORES = {
  settings: 'settings',
  peers: 'peers',
  conversations: 'conversations',
  messages: 'messages',
  outbox: 'outbox',
} as const;

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export class PairwireStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  async getOrCreateDeviceId(): Promise<string> {
    return this.withOneStore(STORES.settings, 'readwrite', async (store) => {
      const existing = await requestResult(
        store.get('deviceId') as IDBRequest<SettingsRecord | undefined>,
      );
      if (existing?.value) return existing.value;
      const id = crypto.randomUUID();
      await requestResult(store.put({ key: 'deviceId', value: id } satisfies SettingsRecord));
      return id;
    });
  }

  async getStoredDisplayName(): Promise<string | null> {
    const value = await this.getSetting('displayName');
    const normalized = value?.trim();
    if (!normalized || normalized.length > 48 || containsControlCharacters(normalized)) return null;
    return normalized;
  }

  async getDisplayName(): Promise<string> {
    return (await this.getStoredDisplayName()) ?? 'You';
  }

  async setDisplayName(name: string): Promise<void> {
    const normalized = name.trim();
    if (!normalized || normalized.length > 48 || containsControlCharacters(normalized)) {
      throw new StorageError('Display names must contain 1–48 visible characters.');
    }
    await this.setSetting('displayName', normalized);
  }

  async getPeers(): Promise<PeerRecord[]> {
    return this.withOneStore(STORES.peers, 'readonly', (store) =>
      requestResult(store.getAll() as IDBRequest<PeerRecord[]>),
    );
  }

  async savePeer(peer: PeerRecord): Promise<void> {
    await this.withStores([STORES.peers, STORES.conversations], 'readwrite', async (stores) => {
      const peers = stores[STORES.peers];
      const conversations = stores[STORES.conversations];
      if (!peers || !conversations) throw new StorageError('Storage schema is incomplete.');
      await requestResult(peers.put(peer));
      const current = await requestResult(
        conversations.get(peer.conversationId) as IDBRequest<ConversationRecord | undefined>,
      );
      await requestResult(
        conversations.put({
          ...current,
          id: peer.conversationId,
          peerId: peer.id,
          updatedAt: Math.max(current?.updatedAt ?? 0, peer.lastSeenAt),
        }),
      );
    });
  }

  async getConversations(): Promise<ConversationRecord[]> {
    return this.withOneStore(STORES.conversations, 'readonly', (store) =>
      requestResult(store.getAll() as IDBRequest<ConversationRecord[]>),
    );
  }

  async getMessage(id: string): Promise<ChatMessage | undefined> {
    return this.withOneStore(STORES.messages, 'readonly', (store) =>
      requestResult(store.get(id) as IDBRequest<ChatMessage | undefined>),
    );
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.withOneStore(STORES.messages, 'readonly', (store) =>
      requestResult(
        store.index('byConversation').getAll(conversationId) as IDBRequest<ChatMessage[]>,
      ),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async deleteConversation(peerId: string, conversationId: string): Promise<void> {
    try {
      await this.withStores(
        [STORES.peers, STORES.conversations, STORES.messages, STORES.outbox],
        'readwrite',
        async (stores) => {
          const peers = stores[STORES.peers];
          const conversations = stores[STORES.conversations];
          const messages = stores[STORES.messages];
          const outbox = stores[STORES.outbox];
          if (!peers || !conversations || !messages || !outbox)
            throw new StorageError('Storage schema is incomplete.');
          const conversationMessages = await requestResult(
            messages.index('byConversation').getAll(conversationId) as IDBRequest<ChatMessage[]>,
          );
          const queuedMessages = await requestResult(outbox.getAll() as IDBRequest<ChatMessage[]>);
          await requestResult(peers.delete(peerId));
          await requestResult(conversations.delete(conversationId));
          for (const message of conversationMessages)
            await requestResult(messages.delete(message.id));
          for (const message of queuedMessages) {
            if (message.toPeerId === peerId) await requestResult(outbox.delete(message.id));
          }
        },
      );
    } catch (error) {
      throw wrapStorageError('Could not delete this conversation.', error);
    }
  }

  async createOutgoing(message: ChatMessage): Promise<void> {
    try {
      await this.withStores(
        [STORES.messages, STORES.outbox, STORES.conversations],
        'readwrite',
        async (stores) => {
          const messages = stores[STORES.messages];
          const outbox = stores[STORES.outbox];
          const conversations = stores[STORES.conversations];
          if (!messages || !outbox || !conversations)
            throw new StorageError('Storage schema is incomplete.');
          await requestResult(messages.add(message));
          await requestResult(outbox.put(message));
          const previous = await requestResult(
            conversations.get(message.conversationId) as IDBRequest<ConversationRecord | undefined>,
          );
          await requestResult(
            conversations.put({
              ...previous,
              id: message.conversationId,
              peerId: message.toPeerId,
              updatedAt: Math.max(previous?.updatedAt ?? 0, message.createdAt),
              lastMessage:
                message.createdAt >= (previous?.lastMessageAt ?? 0)
                  ? message.text
                  : previous?.lastMessage,
              lastMessageAt: Math.max(previous?.lastMessageAt ?? 0, message.createdAt),
            }),
          );
        },
      );
    } catch (error) {
      throw wrapStorageError('Could not save outgoing message.', error);
    }
  }

  async commitIncoming(message: ChatMessage): Promise<{ inserted: boolean; message: ChatMessage }> {
    try {
      return await this.withStores(
        [STORES.messages, STORES.conversations],
        'readwrite',
        async (stores) => {
          const messages = stores[STORES.messages];
          const conversations = stores[STORES.conversations];
          if (!messages || !conversations) throw new StorageError('Storage schema is incomplete.');
          const existing = await requestResult(
            messages.get(message.id) as IDBRequest<ChatMessage | undefined>,
          );
          if (existing) {
            if (!hasSameMessageIdentity(existing, message)) {
              throw new StorageError(
                'A message ID was reused with different content. The conflicting message was rejected.',
              );
            }
            return { inserted: false, message: existing };
          }
          await requestResult(messages.add(message));
          const previous = await requestResult(
            conversations.get(message.conversationId) as IDBRequest<ConversationRecord | undefined>,
          );
          await requestResult(
            conversations.put({
              ...previous,
              id: message.conversationId,
              peerId: message.fromPeerId,
              updatedAt: Math.max(previous?.updatedAt ?? 0, message.createdAt),
              lastMessage:
                message.createdAt >= (previous?.lastMessageAt ?? 0)
                  ? message.text
                  : previous?.lastMessage,
              lastMessageAt: Math.max(previous?.lastMessageAt ?? 0, message.createdAt),
            }),
          );
          return { inserted: true, message };
        },
      );
    } catch (error) {
      throw wrapStorageError('Could not persist incoming message.', error);
    }
  }

  async setMessageStatus(id: string, nextStatus: MessageStatus): Promise<ChatMessage | undefined> {
    try {
      return await this.withStores(
        [STORES.messages, STORES.outbox],
        'readwrite',
        async (stores) => {
          const messages = stores[STORES.messages];
          const outbox = stores[STORES.outbox];
          if (!messages || !outbox) throw new StorageError('Storage schema is incomplete.');
          const current = await requestResult(
            messages.get(id) as IDBRequest<ChatMessage | undefined>,
          );
          if (!current) return undefined;
          if (current.status === 'delivered') return current;
          const status = transitionMessage(current.status, nextStatus);
          const updated = { ...current, status };
          await requestResult(messages.put(updated));
          if (status === 'delivered') await requestResult(outbox.delete(id));
          else await requestResult(outbox.put(updated));
          return updated;
        },
      );
    } catch (error) {
      throw wrapStorageError(`Could not update message ${id}.`, error);
    }
  }

  async retryMessage(id: string): Promise<ChatMessage | undefined> {
    return this.setMessageStatus(id, 'pending');
  }

  async getOutbox(): Promise<ChatMessage[]> {
    const rows = await this.withOneStore(STORES.outbox, 'readonly', (store) =>
      requestResult(store.getAll() as IDBRequest<ChatMessage[]>),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async recoverOutboxAfterRestart(): Promise<void> {
    await this.withStores([STORES.messages, STORES.outbox], 'readwrite', async (stores) => {
      const messages = stores[STORES.messages];
      const outbox = stores[STORES.outbox];
      if (!messages || !outbox) throw new StorageError('Storage schema is incomplete.');
      const queued = await requestResult(outbox.getAll() as IDBRequest<ChatMessage[]>);
      for (const message of queued) {
        if (message.status !== 'sending' && message.status !== 'sent') continue;
        const recovered = { ...message, status: 'pending' as const };
        await requestResult(messages.put(recovered));
        await requestResult(outbox.put(recovered));
      }
    });
  }

  private async getSetting(key: string): Promise<string | undefined> {
    const row = await this.withOneStore(STORES.settings, 'readonly', (store) =>
      requestResult(store.get(key) as IDBRequest<SettingsRecord | undefined>),
    );
    return row?.value;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.withOneStore(STORES.settings, 'readwrite', async (store) => {
      await requestResult(store.put({ key, value } satisfies SettingsRecord));
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
      try {
        transaction.abort();
      } catch {
        /* The transaction may already be inactive. */
      }
      try {
        await done;
      } catch {
        /* Preserve the operation error. */
      }
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
      try {
        transaction.abort();
      } catch {
        /* The transaction may already be inactive. */
      }
      try {
        await done;
      } catch {
        /* Preserve the operation error. */
      }
      throw error;
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.databasePromise === promise) this.databasePromise = null;
        reject(error);
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.settings))
          db.createObjectStore(STORES.settings, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORES.peers))
          db.createObjectStore(STORES.peers, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORES.conversations))
          db.createObjectStore(STORES.conversations, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORES.messages)) {
          const messages = db.createObjectStore(STORES.messages, { keyPath: 'id' });
          messages.createIndex('byConversation', 'conversationId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.outbox))
          db.createObjectStore(STORES.outbox, { keyPath: 'id' });
      };

      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          if (this.databasePromise === promise) this.databasePromise = null;
        };
        resolve(db);
      };
      request.onerror = () =>
        fail(wrapStorageError('Could not open local message storage.', request.error));
      request.onblocked = () =>
        fail(
          new StorageError(
            'Storage upgrade is blocked by another tab. Close other Pairwire tabs and retry.',
          ),
        );
    });

    this.databasePromise = promise;
    return promise;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new StorageError('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new StorageError('Transaction aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new StorageError('Transaction failed.'));
  });
}

function wrapStorageError(message: string, error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(message, error instanceof Error ? { cause: error } : undefined);
}
