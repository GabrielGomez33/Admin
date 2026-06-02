# Goal 1 — Revert PR #56 service worker regression

## What broke

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

## What this folder contains

A drop-in replacement for ONE file in the `Mirror` repo:

```
mirror-frontend/
└── client/
    └── src/
        └── sw.ts        ← copy over client/src/sw.ts in Mirror
```

`sw.ts` is restored to its pre-PR-#56 form: the SPA navigation route once
again uses `createHandlerBoundToURL('/Mirror/index.html')` from
`workbox-precaching`, so the navigation fallback is served from the same
precache that holds `manifest.webmanifest`, the PWA icons, and the push
notification icon/badge.

## What is intentionally NOT reverted

- `client/src/context/AuthContext.tsx` (live-email-on-refresh write to the
  persisted `userInfo` blob) — pure `localStorage.setItem`, no React state
  side effects, harmless. Leave the deployed file as-is.
- `mirror-server/controllers/authController.ts` (`verifyToken` reading the
  live DB email) — pairs with the AuthContext change above. Leave as-is.

## Deployment

1. Copy `mirror-frontend/client/src/sw.ts` over `client/src/sw.ts` in the
   Mirror checkout.
2. Rebuild and deploy the client (`npm run build` in `client/`).
3. After deploy, users will see the UpdateBanner; clicking Reload will
   activate the corrected SW. `cleanupOutdatedCaches()` will tidy any
   orphan `mirror-app-shell` cache left over from PR #56.
4. Verify in Chrome DevTools > Application:
   - Manifest panel renders the Mirror manifest.
   - Cache Storage shows the workbox precache populated with `index.html`,
     `manifest.webmanifest`, `pwa-*.png`, etc.
   - Push notifications fire end-to-end.
   - Dina "processing" indicator + streaming response render live (no
     refresh required).

If symptom (b) — Dina processing not visible / response only on refresh —
persists after the SW revert, it is unrelated to PR #56 and should be
investigated separately as a Chat/Dina event-subscription issue.
