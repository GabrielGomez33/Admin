# Goal 2 — Chat WS reconnect race + join_group protocol fix

## What's broken on master (pre-this-drop)

Mobile users reported **intermittent Dina**: queries work, then silently
don't, then work again, with Dina responses only appearing after a hard
refresh. Push notifications and offline caching are unaffected.

Root cause is a two-bug chain in `wss/chatWSHandler.ts`:

### Bug A — `chat:join_group` ack protocol mismatch

Server's `handleJoinGroup` responds with `chat:group_joined` carrying the
`requestId`. The client (`chatWebSocket.ts`) only resolves pending
`sendWithAck` promises on messages of type `chat:ack`. Every other server
handler (send / edit / delete / mark_read / add+remove_reaction) correctly
uses `chat:ack`. Join (and leave) were inconsistent. Result: the
UI-initiated `joinChatGroup(groupId)` always times out at 10s — visible in
the console as `[ChatContext] Failed to join chat group: Error: Request
timeout after 10000ms for chat:join_group`. The server-side join actually
DOES happen (membership row is added to `groupSubscriptions`), so this is
silent until something else interacts with the join state.

### Bug B — `unregisterUser` race condition (the Dina killer)

`registerUser` synchronously replaces the entry in `this.users` for a
returning user, while the **old** WebSocket's `close()` is async. The old
socket's `close` event fires later and runs `unregisterUser(userId)`,
which reads `this.users.get(userId)` — getting the **new** registration —
then loops over its activeGroups, removes it from `groupSubscriptions`,
and finally does `this.users.delete(userId)`. The user is now invisible to
the server even though their (new) WebSocket is open and the client thinks
it's connected and joined.

This is why Dina events appear to fall on the floor only after a
reconnect: every `broadcastToGroup(...)` call for `dina:processing_start`,
`dina:stream_*`, and the final `chat:message` does
`subscribers.has(userId)` → false (or sends to a deleted user), so all
five events are dropped to that client. The message IS persisted to the
DB by `ChatMessageManager`, which is why a refresh — which fetches from
the DB — surfaces Dina's response.

Mobile networks reconnect 5–20× per day (background→foreground, captive
portals, signal blips), so this race is hit constantly on phones and only
sporadically on desktop.

## What this folder contains

Three drop-in file replacements:

```
mirror-server/
├── wss/
│   ├── chatWSHandler.ts    ← replaces mirror-server's wss/chatWSHandler.ts
│   └── setupWSS.ts         ← replaces mirror-server's wss/setupWSS.ts
└── README.md               ← this file
```

(Paired with `../mirror-frontend/client/src/services/chatWebSocket.ts` —
see that folder's README. The client change is a defense-in-depth ack
fallthrough; it is NOT required for the server fix to work, but it makes
the protocol resilient to any future drift.)

## What changed, surgically

### `wss/chatWSHandler.ts`

1. **`unregisterUser(userId, ws?)`** — second parameter added. When supplied,
   we only act if `this.users.get(userId).ws === ws`. Without that guard,
   a stale close event from a replaced socket would wipe the live
   registration. The optional shape preserves backward compatibility for
   any internal caller that genuinely wants force-unregister semantics.

2. **`handleJoinGroup`** — now sends `chat:ack` (carrying the `requestId`)
   to resolve the client's pending promise, THEN emits `chat:group_joined`
   (no `requestId`) as the semantic event for UI listeners. Two messages
   instead of one, but both are tiny (< 200 bytes) and the protocol now
   matches every other handler in the file.

3. **`handleLeaveGroup`** — same pattern: `chat:ack` first, then
   `chat:group_left`.

No other logic changed. No public API broken. No DB schema impact.

### `wss/setupWSS.ts`

Two-line change inside the `/mirror/groups/chat` route: pass `ws` to both
`chatWSHandler.unregisterUser(decoded.id, ws)` calls (one in
`ws.on('close')`, one in `ws.on('error')`). This wires the new stale-WS
guard. Any other caller of `unregisterUser` continues to work because the
second parameter is optional.

## Enterprise concerns addressed

- **Backward compatibility:** old clients (running pre-fix `chatWebSocket.ts`)
  WILL accept the new server messages — they'll get a `chat:ack` they
  don't currently match by type, then the `chat:group_joined` they DO
  match by type. Pending requests still time out for them at 10s, exactly
  the existing behavior. The client-side ack fallthrough in
  `mirror-frontend/client/src/services/chatWebSocket.ts` upgrades old
  clients to the new behavior once the client deploy lands.
- **Forward compatibility:** new clients (with the ack-fallthrough)
  against the OLD server: the client now resolves the pending request on
  any `requestId`-carrying message regardless of type, so the old
  `chat:group_joined`-with-requestId path also works. Net: the two halves
  of this fix are independent — ship server first OR client first; either
  improves things; both yield the full fix.
- **Observability:** stale-close path emits
  `👤 Chat unregisterUser: skipping stale close for user N (newer
  connection has taken over)`. Grep for that string in `pm2 logs
  mirror-server` to confirm the guard is firing in production. Frequency
  is a leading indicator of mobile network churn.
- **Edge cases handled:**
  - `unregisterUser` called with no `ws` (e.g. shutdown sweep) — still
    works, unconditional cleanup.
  - `unregisterUser` called with `ws` BUT no current user — early return,
    no spurious delete.
  - `unregisterUser` called while user is mid-join — `users.get(userId)`
    returns the new user; the ws-identity check matches; cleanup proceeds
    safely.
  - Auto-rejoin fire-and-forget on `onopen` (client-side
    `subscribedGroups.forEach`) continues to work exactly as before —
    the server's `chat:ack` for the implicit requestId-less join is a
    no-op on the client (no pending request to resolve), and the
    `chat:group_joined` event still fires for any UI listener.
- **Security:** no new attack surface. The `mirror_group_members` membership
  check at the top of `handleJoinGroup` is unchanged. The stale-WS guard
  is identity-only (`user.ws !== ws`), not content-dependent. Nothing
  from a client is trusted in this comparison.
- **No DB impact:** zero schema changes, zero new queries, zero migration.
- **No new dependencies:** only existing imports.

## Deployment

```bash
# On the mirror-server checkout:
cp <admin-checkout>/mirror-server/wss/chatWSHandler.ts wss/chatWSHandler.ts
cp <admin-checkout>/mirror-server/wss/setupWSS.ts        wss/setupWSS.ts

# Type-check before reload — the changes are TypeScript-compatible
# with the existing tsconfig but always verify locally:
npx tsc --noEmit

# Reload mirror-server (worker processes import setupWSS transitively
# only through chatWSHandler, not directly — `pm2 reload mirror-server`
# is sufficient; the DinaChatQueueProcessor worker does NOT need a
# restart because its imports are unchanged):
pm2 reload mirror-server
```

Ship the paired client change from `../mirror-frontend/` in the same
deploy window so both halves of the fix land together.

## Verification protocol (run on staging before prod)

### 1. Smoke test — single connection, no reconnect

1. Open the app, log in.
2. Open chat for a group you're a member of.
3. Console should NOT show
   `[ChatContext] Failed to join chat group: Error: Request timeout...`.
4. Server log should show `📥 User N joined chat group G` exactly once.
5. Send `@dina hello`. Confirm:
   - `dina:processing_start` reaches the client (Dina "thinking" indicator
     renders).
   - `dina:stream_start` → `dina:stream_chunk` → `dina:stream_complete`
     all reach the client (streaming response renders character-by-
     character).
   - Final `chat:message` from Dina renders without refresh.

### 2. Reconnect-race test — the bug we just fixed

1. Open the app, log in, enter a group chat.
2. DevTools → Network → throttle to "Offline" for 5 seconds, then back to
   "No throttling".
3. Verify console shows `[ChatWS] Connection closed` then
   `[ChatWS] Connected successfully`.
4. Server log should show:
   - `Chat WebSocket connection closed for user N`
   - `👤 Chat unregisterUser: skipping stale close for user N (newer
     connection has taken over)` — confirms the guard fired.
   - `👤 Chat user registered: N (...)` for the new connection.
   - `📥 User N joined chat group G` from the rejoin.
5. Send `@dina test`. All Dina events must render live, no refresh
   needed.
6. Repeat steps 2–5 ten times in a row. Dina must work every iteration.

### 3. Edge case — rapid back-to-back reconnects

1. With chat open, toggle Network → Offline → No-throttling rapidly four
   times in 10 seconds.
2. Server log should remain coherent: each "skipping stale close"
   message corresponds to a "user registered" message of the same userId,
   with no `User not connected` errors and no `removeFromGroup` log spam.
3. After the storm subsides, send `@dina ping`. Dina must respond.

### 4. Mobile real-world test

1. Open the deployed PWA on iOS Safari AND Android Chrome.
2. Open chat, send `@dina`. Confirm response.
3. Background the app for 30 seconds. Reopen. Send `@dina`. Confirm
   response with no refresh.
4. Walk to a known dead-zone. Wait 30 seconds. Walk back. Send `@dina`.
   Confirm response.
5. Repeat the dead-zone test 5 times. Dina must work every iteration.

## Rollback

If any verification step fails:

```bash
git checkout HEAD~1 -- wss/chatWSHandler.ts wss/setupWSS.ts
pm2 reload mirror-server
```

(Or restore from the prior `master` if the fix was already committed and
pushed.)

The client safety net (`chatWebSocket.ts` requestId-fallthrough) is
independently rollback-safe — it doesn't depend on this server change to
work, so leaving it in place during a server rollback is fine.
