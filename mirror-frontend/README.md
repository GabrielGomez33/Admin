# mirror-frontend drops — Goal #1 + Goal #2 client safety net

This folder contains TWO independent fixes. Read both sections; ship in any
order (each is independently valuable).

---

## Goal 1 — Revert PR #56 service worker regression

### What broke

PR #56 (merged 2026-06-01, from commit `2dd1c1d` dated 2026-05-26) replaced
the precache-backed SPA navigation fallback with a hand-rolled `NetworkFirst`
strategy writing to a separate `mirror-app-shell` cache. After activation
(via the UpdateBanner reload prompt) this manifested on Chrome as:

- Application > Manifest: empty.
- Application > Cache Storage: stale / missing entries.
- Push notifications stop firing even though `sw.js` is shown as active.
- Live UI updates (e.g. Dina "processing" indicator, streaming response)
  silently don't render until a full refresh, because activated clients
  end up running a mismatched bundle/shell pairing.

### What this folder contains for Goal #1

A drop-in replacement for ONE file:

```
mirror-frontend/client/src/sw.ts        ← copy over client/src/sw.ts in Mirror
```

Restored to its pre-PR-#56 form: the SPA navigation route again uses
`createHandlerBoundToURL('/Mirror/index.html')` from `workbox-precaching`,
so the navigation fallback is served from the same precache that holds
`manifest.webmanifest`, the PWA icons, and the push notification
icon/badge.

This was deployed via PR #57. If you're reading this AFTER PR #57 merged,
this file is already in production and the copy is documentary.

### What is intentionally NOT reverted

- `client/src/context/AuthContext.tsx` (live-email-on-refresh) — pure
  `localStorage.setItem`, no React state side effects, harmless. Leave as-is.
- `mirror-server/controllers/authController.ts` (`verifyToken` reading
  the live DB email) — pairs with the AuthContext change above. Leave
  as-is.

---

## Goal 2 — Client requestId-fallthrough (chat WS protocol safety net)

### What this addresses

Paired with the server-side fix in `../mirror-server/` (see that folder's
README for the full bug chain). On the client side, the original
`handleMessage` only honored `chat:ack` as the resolver for pending
`sendWithAck` promises. When the server replied to a `chat:join_group` or
`chat:leave_group` request with `chat:group_joined` / `chat:group_left`
carrying the same `requestId`, the client matched by `type` alone and
silently ignored the ack — so the join Promise sat until its 10s timeout,
even though the server-side join had actually succeeded.

### The fix

`client/src/services/chatWebSocket.ts` — `handleMessage` now resolves
(or rejects, for `chat:error`) ANY pending request whose `requestId`
matches an incoming message, regardless of the message's `type`. The
match-by-type semantic routing below still fires for the corresponding
event handlers — the ack lookup falls through.

### Why this is "defense in depth"

The server-side fix in `../mirror-server/wss/chatWSHandler.ts` makes
join/leave use `chat:ack` like every other handler, so this client change
isn't strictly necessary once the server ships. But:

- It hardens the client against any FUTURE protocol drift where a server
  handler returns a non-`chat:ack` reply with a requestId.
- It allows the two halves of the fix to ship independently (client
  first, server first — either works; both yield the full fix).
- It's a 6-line change with no public API impact and no behavior change
  for the existing happy path (`chat:ack` continues to resolve as
  before, just via the more general branch).

### What this folder contains for Goal #2

```
mirror-frontend/client/src/services/chatWebSocket.ts  ← drop-in replacement
```

### Deployment

```bash
# In the Mirror checkout (develop branch, matching your normal workflow):
git switch develop
git pull origin develop
cp <admin-checkout>/mirror-frontend/client/src/services/chatWebSocket.ts \
   client/src/services/chatWebSocket.ts

# Build + verify:
cd client
npm run build           # confirms TypeScript clean
cd ..
git add client/src/services/chatWebSocket.ts
git commit -m "Chat WS: resolve pending requests on any requestId-carrying message"
git push origin develop

# Then PR develop → master and merge per the usual flow.
```

### Verification (post-deploy on staging)

Open the app, open chat for a group:

- Console should NOT log `Request timeout after 10000ms for chat:join_group`.
- Network panel → WS frames tab → after sending a join, you should see the
  inbound `chat:ack` (or `chat:group_joined` if the server fix hasn't
  shipped yet) arriving within ~100ms of the join request, and the
  ChatContext effect chain should fire `dina:processing_start` /
  `dina:stream_*` immediately when @dina is messaged.

### Rollback

Single-file revert:

```bash
git checkout HEAD~1 -- client/src/services/chatWebSocket.ts
npm run build
# redeploy
```

No state to clean up; the change is purely in-memory and idempotent.

---

## Ship order recommendation

1. **Goal #1 sw.ts** — already in production via PR #57.
2. **Goal #2 server (`../mirror-server/wss/*.ts`)** — addresses the
   intermittent Dina root cause. Ship first if you have only one deploy
   window; the client safety net helps but isn't strictly required.
3. **Goal #2 client (this file's `chatWebSocket.ts`)** — defense in
   depth. Ship in the same window or the next one.

Total surface area: 4 files modified, 0 schemas changed, 0 dependencies
added, 0 endpoints broken.
