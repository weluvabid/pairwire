# Pairwire

**Two browsers. One direct connection. No accounts. No messaging servers.**

Pairwire is an experimental browser-based, peer-to-peer messaging app. It uses WebRTC data channels for chat, clipboard-assisted manual signaling, and IndexedDB for local conversation history and pending messages.

This is a small engineering experiment. There is no application backend, account system, server-side message storage, relay service, or launch infrastructure in this repository.

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
npm install
npm run dev
```

Open <http://localhost:5173>. Vite serves the TypeScript entry point and styles with hot module replacement on `127.0.0.1`. `localhost` is a secure context for browser APIs such as WebRTC and clipboard access.

To build the static site without starting the server:

```sh
npm run build
```

The generated static site lives in `dist/` and can be hosted by any static-file host that serves HTTPS. Pairwire does not need an application server at runtime. For a production deployment, publish the *contents* of `dist/`.

## Pair two browsers

1. Open Pairwire in two browser contexts. They can be two browsers or one normal window and one private window.
2. On first launch in each browser profile, choose a display name. Pairwire stores it in IndexedDB and reuses it for future connections; the name is shared with the other peer as part of the invitation/response identity metadata.
3. In the first browser, choose **New connection**, then **Create & copy invitation**.
4. Share the copied invitation through a messaging channel you already use.
5. In the second browser, choose **Join a connection** and read the invitation from the clipboard.
6. Pairwire validates the invitation, creates a response, and copies it to the clipboard. Send that response back.
7. In the first browser, choose **Read response from clipboard** to complete pairing.
8. Wait for both browsers to show a connected state, then exchange messages.

Pairing data contains WebRTC session information and ICE candidates. It can be larger than a typical QR payload, so Pairwire uses clipboard-assisted exchange. Clipboard access requires a secure context (HTTPS or localhost) and a user gesture. If browser permissions or support prevent clipboard access, Pairwire exposes a manual paste/copy fallback. The app never reads the clipboard automatically when a dialog opens. Do not post an invitation publicly while it is in use.

## Delivery semantics

Pairwire does not equate a successful `RTCDataChannel.send()` call with delivery.

| State | Meaning |
| --- | --- |
| Pending | Saved locally and waiting for a transmission attempt. |
| Sending | A transmission attempt is in progress. |
| Sent | The browser accepted the frame for transmission; remote persistence is not confirmed yet. |
| Delivered | The remote app committed the message to IndexedDB and sent an acknowledgement. |
| Failed | The latest attempt failed. The message stays in the local outbox and can be retried. |

If a connection drops after the remote side saves a message but before the acknowledgement arrives, the sender may transmit it again. The receiver checks the stable message ID transactionally and re-acknowledges duplicates without adding another conversation entry. This gives at-least-once transmission attempts with idempotent receive processing; it does not promise exactly-once network delivery.

Pending messages remain on the sender's device while the recipient is offline. Without a server or another always-on peer, Pairwire cannot deliver to a browser that is not connected. Messages are retried when the peers reconnect.

## Reconnecting to an existing conversation

Disconnecting closes only the WebRTC transport; it does not remove the peer, conversation, message history, or outbox from IndexedDB. Select the existing conversation and choose **Reconnect** (or use its conversation actions menu). Exchange a fresh invitation and response using either pairing role. Pairwire checks the remote device ID against the selected conversation before accepting the signaling payload, so an unrelated peer cannot silently take over that thread. Once the data channel reconnects, eligible outbox messages for that peer are retried automatically.

History, device identity, and your display name are local to the browser profile and origin that created them. The display name is shared with peers during pairing, but it is not an account identity. It is not synchronised between your own devices, and clearing site data or changing browser profiles does not migrate the history or device identity. Pairwire currently supports one active peer connection per browser tab; switching to another peer replaces the active transport.

## Architecture

```text
UI
  └── MessagingService
        ├── WebRtcTransport
        │     └── RTCPeerConnection + RTCDataChannel
        └── PairwireStore
              └── IndexedDB
                    ├── settings
                    ├── peers
                    ├── conversations
                    ├── messages
                    └── outbox
```

The Preact UI renders application state and collects user input. It calls `MessagingService` for pairing, messaging, connection state, and data retrieval; it does not implement transport or persistence semantics. `MessagingService` coordinates transport with persistence. `WebRtcTransport` exchanges frames and exposes connection lifecycle events; it does not decide whether a message was delivered. `PairwireStore` owns transactional local persistence.

The signaling exchange uses a public STUN server to discover network candidates. STUN is not a messaging relay and does not receive chat contents, but it is an external connection-establishment dependency. There is no TURN relay configured, so some restrictive networks will not connect. That is an intentional MVP limit.

## Commands

```sh
npm run dev          # Start the Vite dev server on localhost:5173
npm run build        # Compile core modules and bundle the static site to dist/
npm run preview      # Preview the production build locally
npm run typecheck    # Strict TypeScript check
npm test             # Build and run protocol/state tests with Node's test runner
npm run check        # Typecheck plus tests
npm run hygiene:check # Check final newlines and trailing whitespace
```

The unit tests use Node's built-in test runner. Preact is the UI runtime; DaisyUI and Tailwind CSS are build-time styling dependencies. TypeScript and Vite compile the app into static assets.

## Scope and limitations

- One active peer connection per browser tab; previous peer histories remain locally available.
- Text messages only. No group chat, files, voice/video, read receipts, push notifications, accounts, or multi-device synchronization.
- No server-side message queue, offline relay, or guarantee of network connectivity.
- Browser storage can be cleared or evicted. IndexedDB persistence is local to the browser origin, not a backup service.
- Manual signaling is inconvenient and payloads may be long.
- No TURN relay is included. STUN-assisted direct connection may fail on some networks.
- A WebRTC connection is encrypted in transit by browser-provided DTLS, but this experiment does not implement a separate identity-verification or end-to-end key-management system.
- Delivery confirmation means the remote application persisted the message locally, not that a person read it.

## License

MIT. See [LICENSE](./LICENSE).
