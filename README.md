# Pairwire

**Two browsers. One direct connection. No accounts. No messaging servers.**

Pairwire is an experimental browser-based, peer-to-peer messaging app. It uses WebRTC data channels for chat, clipboard-assisted manual signaling, and IndexedDB for local conversation history and pending messages.

**[Live demo](https://weluvabid.github.io/pairwire/)**

Pairwire connects two browsers directly. There are no accounts or messaging servers; conversations and pending messages stay in each browser’s local storage.

## What works

- Manual WebRTC offer/answer pairing, with no signaling server.
- Direct text messages over an ordered, reliable WebRTC data channel.
- Stable message IDs, a versioned wire envelope, and validated incoming frames.
- Application-level acknowledgements sent only after the received message commits to IndexedDB.
- Transactional outgoing-message and outbox insertion.
- Receiver-side deduplication in the same transaction as message insertion.
- Retry of unacknowledged messages after reconnecting or reloading the page.
- Explicit pending, sending, sent, delivered, and failed states.
- Persisted peer metadata, device identity, display name, conversation history, and pending outbox.
- First-launch display-name setup; the chosen name is stored in IndexedDB and included in invitation/response identity metadata.

## Requirements

- Node.js 22.12 or newer.
- npm 10 or newer.
- A modern browser with WebRTC data channels and IndexedDB.

## Run locally

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite serves the TypeScript entry point and styles with hot module replacement on `127.0.0.1`. `localhost` is a secure context for browser APIs such as WebRTC and clipboard access.

To build the static site without starting the server:

```sh
npm run build
```

## Pair two browsers

1. Open Pairwire in two browser contexts. They can be two browsers or one normal window and one private window.
2. On first launch in each browser profile, choose a display name. Pairwire stores it in IndexedDB and reuses it for future connections; the name is shared with the other peer as part of the invitation/response identity metadata.
3. In the first browser, choose **New connection**, then **Create & copy invitation**.
4. Share the copied invitation through a messaging channel you already use.
5. In the second browser, paste the invitation into **Have an invitation or response?**. Pairwire recognises it and offers **Accept invitation**.
6. Accepting creates a response and copies it to the clipboard. Send that response back.
7. In the first browser, paste the response into the same field and choose **Complete connection**.
8. Wait for both browsers to show a connected state, then exchange messages.

To continue an existing conversation, choose its **Reconnect** action. Pairwire creates a fresh invitation tied to the existing peer identity, preserving local history. Pairing data contains WebRTC session information and ICE candidates. Share it through a messaging channel you already use; Pairwire copies generated invitations and responses when browser clipboard writing is available, with a manual-copy fallback otherwise. Incoming text is always pasted manually because some browsers restrict clipboard reads. Pairwire validates the pasted payload before enabling an action and never reads the clipboard automatically. Do not post an invitation publicly while it is in use.

## Delivery semantics

Pairwire does not equate a successful `RTCDataChannel.send()` call with delivery.

| State     | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| Pending   | Saved locally and waiting for a transmission attempt.                                     |
| Sending   | A transmission attempt is in progress.                                                    |
| Sent      | The browser accepted the frame for transmission; remote persistence is not confirmed yet. |
| Delivered | The remote app committed the message to IndexedDB and sent an acknowledgement.            |
| Failed    | The latest attempt failed. The message stays in the local outbox and can be retried.      |

If a connection drops after the remote side saves a message but before the acknowledgement arrives, the sender may transmit it again. The receiver checks the stable message ID transactionally and re-acknowledges duplicates without adding another conversation entry. This gives at-least-once transmission attempts with idempotent receive processing; it does not promise exactly-once network delivery.

Pending messages remain on the sender's device while the recipient is offline. Without a server or another always-on peer, Pairwire cannot deliver to a browser that is not connected. Messages are retried when the peers reconnect.

## Reconnecting to an existing conversation

Disconnecting closes only the WebRTC transport; it does not remove the peer, conversation, message history, or outbox from IndexedDB. Select the existing conversation and choose **Reconnect** (or use its conversation actions menu). Exchange a fresh invitation and response using either pairing role. Pairwire checks the remote device ID against the selected conversation before accepting the signaling payload, so an unrelated peer cannot silently take over that thread. Once the data channel reconnects, eligible outbox messages for that peer are retried automatically.

History, device identity, and your display name are local to the browser profile and origin that created them. The display name is shared with peers during pairing, but it is not an account identity. It is not synchronised between your own devices, and clearing site data or changing browser profiles does not migrate the history or device identity. Pairwire currently supports one active peer connection per browser tab; switching to another peer replaces the active transport.

## Architecture

```text
src/
├── app entry (main.tsx)
├── components/       # Preact presentation components, grouped by feature
├── hooks/            # UI lifecycle and state subscriptions
├── services/         # Browser capabilities such as clipboard access
├── utils/            # Pure formatting and derived-data helpers
├── core/             # Protocol, message state, and messaging orchestration
├── transport/        # WebRTC connection and data-channel lifecycle
└── storage/          # IndexedDB transactions and persistence

MessagingService
├── WebRtcTransport
│   └── RTCPeerConnection + RTCDataChannel
└── PairwireStore
    └── IndexedDB
        ├── settings
        ├── peers
        ├── conversations
        ├── messages
        └── outbox
```

The Preact UI renders application state and collects user input. Components are grouped by feature under `src/components`; UI lifecycle hooks live in `src/hooks`; clipboard access is isolated in `src/services`; and pure formatting/derived-data helpers live in `src/utils`. The UI calls `MessagingService` for pairing, messaging, connection state, and data retrieval; it does not implement transport or persistence semantics. `MessagingService` coordinates transport with persistence. `WebRtcTransport` exchanges frames and exposes connection lifecycle events; it does not decide whether a message was delivered. `PairwireStore` owns transactional local persistence. Protocol decoding rejects unsafe timestamps, malformed identifiers, and conflicting message-ID reuse. Incoming frame processing is bounded; if the receive backlog exceeds its limit, the transport closes without acknowledging queued frames so the sender can retry them after reconnecting. Outgoing data-channel writes are serialized and use a 256 KiB high-water mark with a 64 KiB drain threshold, keeping concurrent message and acknowledgement producers within a bounded send queue.

The signaling exchange uses a public STUN server to discover network candidates. STUN is not a messaging relay and does not receive chat contents, but it is an external connection-establishment dependency. Some restrictive networks may not establish a direct connection because Pairwire does not currently use a TURN relay.

## Commands

```sh
npm run dev          # Start the Vite dev server on localhost:5173
npm run build        # Bundle the static site to dist/
npm run preview      # Preview the production build locally
npm run typecheck    # Strict TypeScript check
npm test             # Compile test modules separately and run Node's test suite
npm run check        # Hygiene, typecheck, and tests
npm run hygiene:check # Check final newlines and trailing whitespace
npm run clean:test   # Remove temporary test compilation output
```

## Scope and limitations

- One active peer connection per browser tab; previous peer histories remain locally available.
- Text messages only. No group chat, files, voice/video, read receipts, push notifications, accounts, or multi-device synchronization.
- No server-side message queue, offline relay, or guarantee of network connectivity.
- Browser storage can be cleared or evicted. IndexedDB persistence is local to the browser origin, not a backup service.
- Manual signaling is inconvenient and payloads may be long.
- No TURN relay is included. STUN-assisted direct connection may fail on some networks.
- WebRTC encrypts messages in transit using DTLS. Pairwire does not currently provide a separate identity-verification or key-management layer.
- Delivery confirmation means the remote application persisted the message locally, not that a person read it.

## Accessibility and keyboard use

Pairwire supports keyboard operation for conversation selection, conversation actions, native dialogs, and message composition. Use Tab and Shift+Tab to move between controls, Enter or Space to activate buttons, Escape to close dismissible dialogs and the mobile conversation drawer, and the arrow keys/Home/End inside a conversation actions menu. In the composer, Enter sends and Shift+Enter inserts a newline.

Reduced-motion preferences are respected.

## License

MIT. See [LICENSE](./LICENSE).
