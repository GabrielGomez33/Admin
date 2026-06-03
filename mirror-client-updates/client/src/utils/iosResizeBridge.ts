// client/src/utils/iosResizeBridge.ts
//
// Why this exists
// ---------------
// On iOS Safari in standalone-PWA mode, `window.resize` does NOT fire
// reliably when:
//   - the soft keyboard dismisses after a focused-input transition,
//   - the visual viewport scale changes during an autofill / focus flow,
//   - the OS restores the layout viewport after a navigation that
//     happened while an input was focused.
//
// Anything in the app that listens to `window.resize` to recompute its
// layout — most notably the Three.js scene components which call
// `renderer.setSize(window.innerWidth, window.innerHeight)` once at
// mount and again on every `resize` event — therefore keeps whatever
// dimensions it was given at mount. If the mount happened while the
// keyboard was up or the viewport was mid-transition (the post-login
// navigation is the textbook case), the layout stays wrong until the
// component remounts (refresh / route change with refetch).
//
// What this module does
// ---------------------
// At app boot, on touch-capable devices, it subscribes to the more
// reliable iOS signals — `visualViewport.resize`, `focusout` from form
// elements, BFCache restore via `pageshow` — and dispatches a synthetic
// `window.resize` event each time one fires. Existing
// `window.addEventListener('resize', ...)` consumers (Three.js scenes,
// virtualized lists, anything else) pick the synthetic event up
// transparently and recompute against the now-correct viewport.
//
// Safety
// ------
//  - Activates only when `matchMedia('(pointer: coarse)').matches` —
//    desktop browsers fire `window.resize` correctly and don't need the
//    bridge. Sniffing pointer type rather than UA avoids both
//    user-agent brittleness and false positives on touchscreen laptops
//    (rare false-fire is acceptable; the work is one frame of layout).
//  - Coalesces all signals through a single `requestAnimationFrame`
//    slot. A flurry of focusout + visualViewport events fires AT MOST
//    one synthetic resize per frame.
//  - Skips dispatch while `document.visibilityState === 'hidden'`.
//    iOS has known false-resize behaviour for backgrounded tabs and
//    PWAs in app-switcher state; firing then would only generate
//    nuisance work for the existing handlers.
//  - The dispatched event is `new Event('resize')` — the same shape
//    a native browser resize uses. Listeners can't tell the difference.
//  - Idempotent install: a second `installIOSResizeBridge()` call is a
//    no-op (e.g. survives React StrictMode double-effect-fire safely if
//    ever called from a component effect).

let pending = false;
let rafId: number | null = null;
let installed = false;

function scheduleSyntheticResize(): void {
  if (pending) return;
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'hidden') return;
  pending = true;
  rafId = requestAnimationFrame(() => {
    pending = false;
    rafId = null;
    try {
      window.dispatchEvent(new Event('resize'));
    } catch {
      // Defensive: if dispatch throws (it shouldn't on any browser
      // that runs Mirror), swallow so we don't trip the rAF callback.
    }
  });
}

function handleFocusOut(e: FocusEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const tag = target.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
  // Give iOS one frame to settle the visual viewport before we read
  // dimensions. Without this, listeners would see the still-shrunk
  // pre-dismiss innerHeight. The double-rAF (here + inside
  // scheduleSyntheticResize) intentionally pushes the dispatch to the
  // SECOND frame after focusout.
  requestAnimationFrame(scheduleSyntheticResize);
}

function handlePageShow(e: Event): void {
  // Only fire on BFCache-restored pageshow; the initial pageshow
  // already runs through React mount + the existing native resize
  // listener.
  if ((e as PageTransitionEvent).persisted) {
    scheduleSyntheticResize();
  }
}

export function installIOSResizeBridge(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;

  // Skip on devices where window.resize behaves correctly.
  if (typeof matchMedia !== 'function') return;
  if (!matchMedia('(pointer: coarse)').matches) return;

  installed = true;

  window.visualViewport?.addEventListener('resize', scheduleSyntheticResize);
  document.addEventListener('focusout', handleFocusOut);
  window.addEventListener('pageshow', handlePageShow);
}

export function uninstallIOSResizeBridge(): void {
  if (!installed) return;
  window.visualViewport?.removeEventListener('resize', scheduleSyntheticResize);
  document.removeEventListener('focusout', handleFocusOut);
  window.removeEventListener('pageshow', handlePageShow);
  if (rafId !== null) cancelAnimationFrame(rafId);
  pending = false;
  rafId = null;
  installed = false;
}
