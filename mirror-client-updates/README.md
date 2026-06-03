# mirror-client-updates — Goals #6, #7, #8

---

## Goal #8 — CI/CD smoke test broke after the apex-redirect went live

### What was wrong

After the Apache apex-redirect vhost shipped (covered in the parent
admin repo session, not in this folder), the next CI/CD run failed on
the smoke-test step:

```
Running smoke test...
Attempt 1/3...
Smoke test response: HTTP 301
Retrying in 3s...
Attempt 2/3...
Smoke test response: HTTP 301
Retrying in 3s...
Attempt 3/3...
Smoke test response: HTTP 301
Error: Smoke test FAILED — /Mirror/ not responding
Error: Process completed with exit code 1.
```

### Why

The smoke test SSHes to the production server and runs:

```bash
curl -sk -o /dev/null -w '%{http_code}' https://localhost/Mirror/
```

That talks to Apache on `127.0.0.1:443` with SNI = `localhost`. After
the Goal #5/#6 series Apache now has TWO `*:443` vhosts:

1. apex redirect — ServerName `theundergroundrailroad.world`,
   `RewriteRule ^/?(.*)$ https://www.theundergroundrailroad.world/$1
   [R=301,L,NE]`. Defined FIRST in source order, so it's also the
   default vhost for unknown SNI like `localhost`.
2. canonical app — ServerName `www.theundergroundrailroad.world`,
   serves the actual `/Mirror/` SPA.

Requests with SNI `localhost` no longer match anything → fall back to
vhost (1) → get a 301 → the smoke test interprets the 301 as failure
and bails.

The Apache config is doing the right thing (unknown hostnames →
redirect to canonical); the smoke test is what's wrong.

### The fix

`.github/workflows/ci-cd.yml` — two surgical edits:

1. **The smoke-test curl** (around line 266): use `--resolve` to map
   the canonical www hostname directly to `127.0.0.1`, then request
   the canonical URL. curl still stays on loopback (no public DNS
   round-trip, no public-internet path) BUT now sends the correct
   SNI + Host header so Apache routes to the app vhost and returns
   200. `-k` is dropped because the cert is valid for the www name.

   ```bash
   curl -s -o /dev/null -w '%{http_code}' \
     --resolve www.theundergroundrailroad.world:443:127.0.0.1 \
     https://www.theundergroundrailroad.world/Mirror/
   ```

2. **The GitHub Actions deployment-environment URL** (around line
   173): change `https://theundergroundrailroad.world/Mirror/` to
   `https://www.theundergroundrailroad.world/Mirror/`. This is the
   link surfaced in the Deployments tab and PR sidebar — purely
   cosmetic, but worth updating in the same edit so the environment
   link doesn't take reviewers through a 301 hop.

### What this folder contains for Goal #8

```
mirror-client-updates/.github/workflows/ci-cd.yml   ← drop-in replacement
```

Diff vs the file at HEAD on Mirror is exactly the two edits above
plus a multi-line WHY comment above the smoke-test loop. Run
`diff` after copy to confirm the surgical scope before committing.

### Why I didn't relax curl with `-L` instead

`curl -L` would silently follow the 301 — the smoke test would pass
again. But then it's no longer testing what it claims to test:

- It would test that the redirect works.
- It would test the canonical URL behind it.
- It would NOT test that the deploy targeted the right place.

Worse, `-L` would mask FUTURE regressions where the smoke test starts
hitting an unintended URL via a chain of redirects. `--resolve`
explicitly identifies the intended target and refuses to be misled.

### Deployment

```bash
# In the Mirror checkout (develop branch):
cp <admin-checkout>/mirror-client-updates/.github/workflows/ci-cd.yml \
   .github/workflows/ci-cd.yml

git diff .github/workflows/ci-cd.yml
# Expect: the two edits above, nothing else.

git add .github/workflows/ci-cd.yml
git commit -m "ci: fix smoke test after apex-to-www redirect"
git push
```

The next CI/CD run on the next merge to `main` (or whichever branch
triggers the deploy) will use the corrected smoke test. The first
attempt after deploy should print `HTTP 200` and exit 0.

### Verification

After the next CI run completes, check the GitHub Actions log for
the deploy job. The Smoke test step should print:

```
Attempt 1/3...
Smoke test response: HTTP 200
Smoke test PASSED — /Mirror/ returns 200
```

If it still prints 301: `--resolve` didn't apply (curl version
mismatch — `--resolve` is in curl ≥ 7.21.3 which is ancient, so this
is essentially impossible on any current Ubuntu) OR the apex vhost
ordering changed and the canonical vhost is no longer named
www.theundergroundrailroad.world. Either is a config drift to chase
separately.

If it prints `HTTP 000`: the SSH itself failed — server unreachable
or the deploy key rotated. That's an infra issue, not this workflow
edit.

### Rollback

```bash
git checkout HEAD~1 -- .github/workflows/ci-cd.yml
git commit -m "ci: revert smoke test fix"
git push
```

The previous smoke test would once again fail against the new Apache
config (returning 301), so a rollback only makes sense if you're ALSO
rolling back the apex-redirect vhost on the server.

---

## Goal #7 — Fix iOS PWA "stuck-layout-after-login" (Three.js canvas + general resize-stale state)

This folder follows the same "drop-in patch for the Mirror client" pattern
as `../mirror-frontend/`. Files here are intended to be copied verbatim
into the corresponding paths inside the Mirror checkout
(https://github.com/GabrielGomez33/Mirror).

---

## Goal #7 — Fix iOS PWA "stuck-layout-after-login" (Three.js canvas + general resize-stale state)

### What was wrong

Reported on 2026-06-03 from a live phone session: after logging in on
the iOS installed PWA, the post-login page rendered with the Three.js
background canvas (BasicScene / ZenPondScene / SakuraForestScene /
ZenBridgeScene / ZenGardenScene / ZenPondScene2) crammed into a small
rectangle at the top-left of the screen, with most of the page empty.
A pinch-zoom did NOT fix it; the only repair was a refresh or a route
change that triggered a refetch + remount.

### Root cause

Each Three.js scene file has the same fragile pattern (six occurrences —
search the Mirror repo for `renderer.setSize(window.innerWidth`):

```ts
renderer.setSize(window.innerWidth, window.innerHeight);
// ...
function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', handleResize);
```

On iOS Safari **in standalone-PWA mode**, `window.resize` does NOT fire
reliably in three situations that all happen during the login flow:

1. When the soft keyboard dismisses after the user taps Login.
2. When the visual viewport scale changes during autofill / Keychain.
3. When the OS restores the layout viewport after a route change that
   happened while an input was focused.

The chain in the bug:

- User types in the email field → keyboard up, viewport reduced.
- User taps Login → form submits → auth round-trip → React Router
  navigates from `/login` to `/home` (or wherever the post-login
  landing is).
- The new page mounts. Inside, BasicScene's `useEffect` reads
  `window.innerWidth` / `window.innerHeight` AT THAT INSTANT — and
  iOS is still mid-transition, returning the smaller keyboard-open
  values.
- `renderer.setSize()` writes those small dimensions into both the
  canvas's pixel buffer and its CSS box.
- iOS finishes dismissing the keyboard a fraction of a second later,
  but does NOT fire `window.resize` — so `handleResize` never runs.
- The canvas is stuck at the small dimensions until React remounts it
  (refresh / route change with refetch).
- Pinch-zoom can't help because pinch-zoom triggers no resize event
  the scene listens to.

The non-canvas layout in the screenshot also looks wrong because the
content sections that are sized with `min-h-screen` resolve against the
same iOS-reported dimensions for the duration of the transient state;
a paint that happens during that window paints stale layout.

### What this folder contains for Goal #7

```
mirror-client-updates/client/src/utils/iosResizeBridge.ts   ← NEW file
mirror-client-updates/client/src/main.tsx                   ← one-line import added
```

### What the bridge does

A tiny module (no React, no dependencies, ~100 lines including
comments) that, at app boot on touch-capable devices, listens to the
iOS signals that ARE reliable:

- `visualViewport.resize` — fires whenever iOS's visual viewport
  changes, including post-keyboard-dismiss settle.
- `focusout` from `INPUT` / `TEXTAREA` / `SELECT` — fires the instant
  the user (or programmatic submit) takes focus off an input,
  i.e. just before the keyboard begins dismissing.
- `pageshow` with `persisted: true` — fires after a BFCache restore
  (iOS swipe-back gesture from another app, etc).

When ANY of those fire, the bridge dispatches a synthetic
`window.resize` Event after one animation-frame tick. Every existing
`window.addEventListener('resize', ...)` consumer in the app — all
six Three.js scenes, any virtualized list, anything else — picks the
synthetic event up exactly like a native one and recomputes against
the now-correct `window.innerWidth` / `window.innerHeight`.

### Why this approach instead of editing each scene file

- **Surface area**: editing six Three.js scene files (BasicScene,
  ZenPondScene, ZenPondScene2, SakuraForestScene, ZenBridgeScene,
  ZenGardenScene) would each receive the same ~10-line resize
  hardening — six full-file drops or six near-identical patches. The
  bridge fixes all six in one shared file without touching any of
  them.
- **Bonus coverage**: every other component in the app that listens
  to `window.resize` for layout — react-virtualized lists, custom
  positioning hooks, anything in dev/ that observes viewport — also
  benefits transparently. Goal #7's blast radius is "the symptom in
  the screenshot AND anything else with the same bug class".
- **Reversibility**: the bridge is a single boolean (`installed`) and
  three event listeners. To roll back, remove the import line from
  `main.tsx`. No code in any scene file has been touched, so there's
  nothing else to back out.

### Safety considerations

- **Pointer:coarse gate**: the bridge installs ONLY on
  `matchMedia('(pointer: coarse)').matches`. Desktop browsers fire
  `window.resize` correctly and don't need the bridge. This avoids
  generating synthetic events for the dev workflow.
- **Coalescing**: a flurry of focusout + visualViewport signals fires
  AT MOST one synthetic resize per animation frame (single rAF slot).
  Worst case: one extra resize per ~16ms during rapid focus-switch
  loops — well below the throttle every native resize listener
  already tolerates.
- **Visibility skip**: the bridge skips dispatch while
  `document.visibilityState === 'hidden'`. iOS has known false-resize
  behaviour for backgrounded tabs; firing during a hidden state would
  generate nuisance work for handlers that are already guarded
  against it.
- **Synthetic event shape**: `new Event('resize')` — the same shape
  browsers fire for native resizes. Native listeners can't tell the
  difference. No special protocol, no opt-in.
- **Idempotent**: a second `installIOSResizeBridge()` call is a
  no-op. Safe under React StrictMode double-mount; safe if some
  future change calls install from an effect.

### Deployment

```bash
# In the Mirror checkout (develop branch):
mkdir -p client/src/utils
cp <admin-checkout>/mirror-client-updates/client/src/utils/iosResizeBridge.ts \
   client/src/utils/iosResizeBridge.ts
cp <admin-checkout>/mirror-client-updates/client/src/main.tsx \
   client/src/main.tsx

# Confirm the diff is exactly: 1 new utility file + 1 import line + 1 call line in main.tsx
git diff client/src/main.tsx
git status client/src/utils/iosResizeBridge.ts

# Build + deploy as usual.
```

### Verification

On a phone after deploy:

1. Open the installed PWA, log out if currently logged in.
2. Open the Login page. Tap the email field — the iOS keyboard
   should come up. Type your email; autofill where applicable.
3. Tap Password, type / autofill it.
4. Tap Login. Wait for auth + navigation.
5. The post-login page should render with the Three.js background
   filling the full screen, the trial banner pinned to top, content
   centered — i.e. it should look like the second screenshot in the
   bug report, NOT the first.
6. Pinch-zoom out: nothing changes (because nothing was wrong).

If the canvas still renders small at the top-left, capture the
visualViewport state with Safari Web Inspector while still in the
broken state (Console: `JSON.stringify({ww: window.innerWidth, wh:
window.innerHeight, vw: visualViewport.width, vh: visualViewport.
height, scale: visualViewport.scale})`) and ping us — that snapshot
identifies whether the iOS signals are firing and the bridge is
missing them, or whether the scene's read is happening before the
bridge's synthetic dispatch lands.

### Rollback

```bash
# Remove the import + call from main.tsx (one-line revert),
# then optionally delete the utility file:
git checkout HEAD -- client/src/main.tsx
rm client/src/utils/iosResizeBridge.ts
```

Single-file revert. Scene files were never touched, so there's
nothing else to back out.

---

## Goal #6 — Make the chat panel practically touch the screen edges on mobile

### What was wrong

Reported on 2026-06-03 from a live phone session: the chat tab inside a
Mirror Group felt cramped — there was a visible ~16px gutter on each
side of the message list and input bar. The constraint came from the
page wrapper in `client/src/pages/MirrorGroupsPage.tsx`:

```tsx
// MirrorGroupsPage.tsx:573 (around the selectedGroupId branch)
<div style={{
  position: 'relative',
  zIndex: 10,
  minHeight: '100vh',
  padding: isMobile ? '1rem' : '1.5rem',     // ← 1rem mobile gutter
}}>
  <div style={{ maxWidth: '56rem', margin: '0 auto' }}>
    <GroupDetailView ... />
  </div>
</div>
```

That `padding: 1rem` (mobile) was intentional for the OTHER group tabs
(overview, members, insights, voting, sharing) — they all want
breathing room. But for chat it meant the message list and composer
input were artificially narrower than they needed to be on a small
screen.

### Why we DIDN'T just edit the TSX

Two reasons:

1. **Blast radius**: editing line 573 would widen every tab, not just
   chat. The other tabs were never cramped — they have cards, lists,
   spacing that need the 1rem. Don't break what isn't broken.
2. **One-tab problem deserves a one-tab fix**: the only tab that wants
   to break out is chat. The chat root container is
   `.chat-window-container` (defined in
   `client/src/styles/chat-glass.css`), which is the perfect surface
   to scope the override to.

### The fix (CSS-only, mobile-only)

In `client/src/styles/chat-glass.css`, inside the existing
`@media (max-width: 768px)` block, add to `.chat-window-container`:

```css
margin-left: -1rem;
margin-right: -1rem;
width: calc(100% + 2rem);
```

That's it. Negative-margin breakout cancels the 1rem page gutter on
each side; the `width: calc(100% + 2rem)` ensures the box visually
spans the gained area without flex collapse. The outer page wrapper
already has `overflow: hidden`, so nothing escapes horizontally — no
risk of a horizontal scrollbar appearing on mobile Safari/Chrome.

### Why this doesn't break vertical page scroll

The user's concern: "If too wide we'll only be able to scroll up and
down on chat and not on screen."

Translating that — they want the page itself to still be scrollable
even while the chat panel is wide. Two things keep that working:

- `.chat-window-container` retains `max-height: 100vh` (unchanged) —
  it never grows beyond one viewport.
- Above the chat in `GroupDetailView.tsx`, the group header card, the
  invite button, and the tab nav still render normally — so the page
  has surface area above (and the page wrapper has scrollable
  `min-height: 100vh` content). Touching outside the messages list
  still scrolls the page.

Inside the messages list (`.chat-messages-container` at
`chat-glass.css:163`) overflow is `auto` as before, so touching the
list scrolls the list. That's the existing behaviour, not changed.

### What this folder contains

```
mirror-client-updates/client/src/styles/chat-glass.css
```

Full file, identical to Mirror `develop`'s `chat-glass.css` at the
clone snapshot taken 2026-06-03, with the four lines above added
inside the mobile media query (around line 1050).

### Deployment

```bash
# In the Mirror checkout (your normal develop branch workflow):
git switch develop
git pull origin develop
cp <admin-checkout>/mirror-client-updates/client/src/styles/chat-glass.css \
   client/src/styles/chat-glass.css

# Diff should show only the breakout block inside @media (max-width: 768px):
git diff client/src/styles/chat-glass.css

# Build + deploy as usual.
```

### Verification

On a phone (or Chrome devtools mobile emulator at 390×844 or similar):

1. Open a group, switch to the Chat tab.
2. The message bubbles and the input bar should now extend to within
   a couple of pixels of the screen edges, no visible side gutter.
3. Touching the chat header / area outside the messages list should
   still scroll the page (header/tabs scroll out of view).
4. Touching inside the messages list scrolls the messages.
5. Switch to the Overview/Members/Insights/Voting/Sharing tabs —
   they should look exactly as before (1rem gutter intact).

### Rollback

Restore the original mobile media block in `chat-glass.css` (remove
the four added lines).

---

## Pairs with: server-side Goal #5

This client-side widening lands alongside a server-side cleanup in
`../mirror-server/` (Goal #5): suppression of the
`dina_processing_started` notification frame, which was the root cause
of the doubled "DINA: processing started" entries in the Notifications
Center. See `../mirror-server/README.md` for that.

Both can ship independently. They address two different user-reported
complaints from the same screenshot.
