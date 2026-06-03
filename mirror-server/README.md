# mirror-server drops — Goal #2 + Goal #3

Two server-side fixes for the chat / WebSocket subsystem. Goal #3
**supersedes** the Goal #2 server changes — once Goal #3 is shipped, the
Goal #2 surgical patch is no longer needed (Goal #3 is a stronger,
multi-connection design). Read the Goal #3 section first.

---

## Goal 3 — Multi-connection per user (the real fix)

### What this addresses

The user-observed cycle: "as soon as I log in from a different device,
reconnecting begins and never completes; only fix is reopening the browser
or app." Same effect on two browser tabs on one phone, PWA + browser tab
on one device, or two physical devices logged into the same account.

### Root cause — kick-on-register

Both WebSocket subsystems were keyed by `userId` with single-WS-per-user
semantics:

- `wss/chatWSHandler.ts` `registerUser`: when a new connection arrived for
  a userId that already had a registered ws, the code called
  `existing.ws.close(1000, 'New connection established')` and replaced the
  map entry. Effect: every reconnect on device B kicked device A. Device A
  user refreshed (or the visibility handler fired) → reconnected →
  kicked device B → device B user refreshed → kicked A → cycle.
- `systems/mirrorGroupNotifications.ts` `registerConnection`: silently
  overwrote `activeConnections.set(userId, ws)` AND the old ws's `close`
  handler unconditionally deleted the entry — so the old ws's deferred
  close event later nuked the newer registration. Same multi-device
  ping-pong + a stale-close race on top.

### The fix — unlimited connections per user

Both subsystems are rewritten around per-connection identity:

#### `wss/chatWSHandler.ts`

- `users: Map<userId, ChatWSUser>` is gone. Replaced by:
  - `connections: Map<connId, ChatWSUser>` — one entry per live WS.
  - `userConnIds: Map<userId, Set<connId>>` — reverse index for fan-out.
- `groupSubscriptions: Map<groupId, Set<connId>>` — per-connection
  subscription (each device that opens a chat independently subscribes
  its own connection).
- `registerUser` does NOT close any existing connection. Returns the
  new ChatWSUser with a freshly-generated `connId` (UUID). Callers must
  remember the connId to address THIS connection.
- `unregisterUser(connId)` removes only the specific connection. Other
  connections owned by the same userId remain intact. Presence-offline
  is broadcast only when the user's LAST connection closes.
- `handleMessage(connId, data)` looks up the per-connection user record;
  acks are sent to the originating connection only (other tabs/devices
  receive broadcasts on their own merit).
- `sendToUser(userId, message)` is a fan-out: sends to every open
  connection for the user. Returns delivery count.
- `sendToConnection(connId, message)` is the new request/response target.
- `broadcastToGroup(groupId, message, excludeUserId?)` iterates per-connId
  subscribers; the `excludeUserId` exclusion skips ALL connections owned
  by that user (avoids echoing optimistic sends across the sender's
  other tabs; ChatContext dedup handles any remaining race).
- `handleJoinGroup` / `handleLeaveGroup` follow the chat:ack-then-event
  protocol from Goal #2, but addressed per-connection.

#### `wss/setupWSS.ts`

- Captures `connId` from `chatWSHandler.registerUser` and uses it to
  address `handleMessage` / `unregisterUser`. No more userId+ws guard
  (the connId IS the identity).
- `connectedUserIds: Set<number>` replaced with `connectedUserCounts:
  Map<number, number>` so multi-WS users are counted correctly
  (online while count > 0).
- Calls `groupNotifications.registerConnection(userId, ws)` and
  `groupNotifications.unregisterConnection(userId, ws)` — the latter
  now takes ws so we remove only the specific connection.
- Visibility reports forward to `groupNotifications.markUserVisible(userId, ws)`
  / `markUserHidden(userId, ws)` — per-connection visibility.

#### `systems/mirrorGroupNotifications.ts`

- `activeConnections: Map<string, WebSocket>` → `Map<string, Set<WebSocket>>`.
- `userVisibility` (per-user) → `connectionVisibility: WeakMap<WebSocket, …>`
  (per-connection). WeakMap so the entry is GC-able when the ws is
  released; explicit delete on connection close keeps the map tight.
- `registerConnection` adds to the user's set, attaches close/error
  handlers that remove ONLY the specific ws. Never wholesale-wipes the
  user's entry.
- `unregisterConnection(userId, ws?)`:
  - With `ws`: remove only that connection.
  - Without `ws`: force-clear all of the user's connections (used by
    graceful shutdown / session invalidation, not by normal close).
- `isUserActive(userId)`: returns true if ANY of the user's connections
  is OPEN and has reported `visible` within the active window. Means a
  user with one foregrounded tab and one backgrounded tab is correctly
  treated as active — pushing a notification to the hidden tab on
  another device would surface on the device they ARE looking at.
- All raw send sites (`deliverRawWebSocketNotification`,
  `sendDirectWebSocketMessage`, `deliverViaWebSocket`) routed through a
  new private `sendToUserConnections(userId, message)` fan-out helper.
  Each returns true if at least one connection delivered.

### Files

```
mirror-server/
├── wss/
│   ├── chatWSHandler.ts                ← full replacement
│   └── setupWSS.ts                     ← full replacement
├── systems/
│   └── mirrorGroupNotifications.ts     ← partial replacement (~6 sections)
└── README.md                            ← this file
```

`mirrorGroupNotifications.ts` is the ORIGINAL 1182-line file with
~6 sections modified — diff-friendly. The other two files are full
replacements.

### Enterprise concerns

- **No new attack surface.** Authentication unchanged (JWT + session
  validation per connection). Membership check still gates joins.
- **Heartbeat reaps stale connections** — the existing 30s server-side
  ping/pong sweep terminates connections that haven't responded to a
  ping. With multi-connection, this is what cleans up abandoned tabs
  and crashed browsers without disrupting siblings.
- **Backward compatibility on the wire.** Client protocol unchanged.
  No client deploy is required for the multi-device behavior to work
  (the client's existing reconnect loop and rejoin logic just stops
  being kicked, which is what we want).
- **Observability:**
  - `👤 Chat user registered: <id> ... [conn=<8>, total=N]` — new total
    count log shows multi-connection growth.
  - `👤 Chat connection closed: user=<id> conn=<8> remaining=N` —
    confirms ONLY the specific connection closed.
  - `✅ Registered WebSocket connection for user <id> (total=N)` on the
    groups WS — same.
- **Backpressure / memory:** Each ChatWSUser is ~250 bytes (excluding
  the WebSocket object). 10× connections per user × 1000 users = 2.5MB.
  Heartbeat ensures dead ones don't pile up. No quota issues.
- **Edge cases handled:**
  - Same browser tab reconnecting after network blip: brief window with
    2 connections, old one cleaned up on close event OR within 30s
    by heartbeat. Both subscribed to same groups, dedup on client.
  - User logs out: their browser tab closes the WS normally; only that
    connection's entry is removed. Other devices unaffected.
  - Session invalidation (password change, admin force-logout): future
    work — would call `unregisterConnection(userId)` (no ws) to clear
    all. Code path exists.
  - User joins group on device A while device B is also connected:
    device B does NOT auto-receive G events until B independently
    joins (per-connection subscription). Matches client behavior where
    each device's `subscribedGroups` set is per-instance.

### Deployment

```bash
# In the mirror-server checkout:
cp <admin-checkout>/mirror-server/wss/chatWSHandler.ts        wss/chatWSHandler.ts
cp <admin-checkout>/mirror-server/wss/setupWSS.ts             wss/setupWSS.ts
cp <admin-checkout>/mirror-server/systems/mirrorGroupNotifications.ts \
   systems/mirrorGroupNotifications.ts

# Type-check:
npx tsc --noEmit

# Reload mirror-server. NOTE: this affects active WebSocket
# connections — every connected user will be force-disconnected as
# pm2 reloads. Stagger if you have a soft-roll requirement; otherwise
# users will simply reconnect transparently within a few seconds:
pm2 reload mirror-server
```

### Verification

#### A. Multi-device sanity

1. Log into the same account on Device A and Device B.
2. Server log should show TWO `Chat WebSocket connection for user <id>`
   lines and two `👤 Chat user registered: <id> ... [conn=<8>, total=N]`
   lines with growing `total`.
3. Send `@dina hello` from Device A. BOTH devices should see
   `dina:processing_start`, the streaming chunks, and the final
   `chat:message`.
4. Keep Device A open, refresh Device B. Device A's chat must NOT
   disconnect. Server log shows ONE close + ONE new register for
   Device B's connection only. `total` count goes 2 → 1 → 2.
5. Refresh Device A. Same: ONLY A's connection cycles; B stays up.
6. Repeat steps 4–5 ten times. Dina must keep working on both
   devices. No "reconnecting…" stuck state anywhere.

#### B. Two-tab single-device

1. Same account, two tabs in one browser.
2. Both tabs show connected.
3. Send `@dina` from tab 1. Both tabs see the response live.
4. Close tab 2. Tab 1 stays connected, no churn.

#### C. Mobile dead-zone walk

1. Open PWA on phone. Log in.
2. Walk to a dead zone. Wait 30s. Walk back.
3. Server log shows the heartbeat sweep terminating the abandoned
   connection (look for `[WS-HEARTBEAT] Dead connection detected`).
   Browser reconnects on visibility/network change.
4. Send `@dina`. Dina responds. No cycle.

#### D. Visibility-skip-push correctness

1. Log in on two devices. Foreground device A, background device B.
2. Trigger a notification (group invite, say).
3. Push should be SKIPPED (because device A reports visible). In-app
   notification renders on device A.
4. Background both devices. Trigger another notification. Push
   should fire on both devices.

### Rollback

```bash
git checkout HEAD~1 -- wss/chatWSHandler.ts wss/setupWSS.ts systems/mirrorGroupNotifications.ts
pm2 reload mirror-server
```

---

## Goal 2 — `chat:join_group` protocol mismatch (SUPERSEDED by Goal #3)

The Goal #2 server-side patch (chat:ack contract + stale-WS guard via
optional ws param to `unregisterUser`) is **subsumed** by Goal #3.
Goal #3's per-connection design eliminates the underlying race more
thoroughly (no shared key between connections to race over) and keeps
the chat:ack-then-event protocol. If you shipped Goal #2 already, the
Goal #3 drop fully replaces those files.

Goal #2's CLIENT change (defense-in-depth requestId fallthrough in
`mirror-frontend/.../chatWebSocket.ts`) is independent of the server
changes and remains valid — ship it alongside or before Goal #3.
