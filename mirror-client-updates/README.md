# mirror-client-updates — Goal #6 chat panel width breakout

This folder follows the same "drop-in patch for the Mirror client" pattern
as `../mirror-frontend/`. Files here are intended to be copied verbatim
into the corresponding paths inside the Mirror checkout
(https://github.com/GabrielGomez33/Mirror).

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
