// ============================================================================
// SERVICE WORKER (Phase 5)
// ============================================================================
// File: src/sw.ts (compiled to dist/sw.js by vite-plugin-pwa injectManifest)
//
// Responsibilities:
//   1. Workbox precache + runtime caching (parity with generateSW Phase 1-3
//      behavior, just authored explicitly).
//   2. push event — receive a push payload, surface as a system notification,
//      update the app badge.
//   3. notificationclick event — focus an existing tab, or open a new one
//      deep-linked to the payload's url.
//   4. message channel — apply skipWaiting on user-triggered Reload only.
//
// IMPORTANT
//   - This file is compiled with the SW global scope, NOT the Window scope.
//     `self` is a ServiceWorkerGlobalScope here. Do not import client code
//     that touches DOM, localStorage, or Window APIs.
//   - The plugin replaces `self.__WB_MANIFEST` with the precache list at
//     build time. Keep the literal `self.__WB_MANIFEST` reference exactly.
// ============================================================================

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, setCatchHandler, NavigationRoute } from 'workbox-routing';
import {
	CacheFirst,
	NetworkFirst,
	StaleWhileRevalidate,
} from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope;

// ============================================================================
// LIFECYCLE
// ============================================================================
//
// clientsClaim: take control of any uncontrolled clients on activation. This
// makes a brand-new install start intercepting fetches immediately on the
// page that just registered the SW, instead of waiting for the next nav.
//
// We do NOT call self.skipWaiting() unconditionally. With registerType:
// 'prompt' in vite.config, the new SW must wait until the user clicks
// "Reload" in UpdateBanner — only then do we skipWaiting via the message
// listener below. This is what gives users a "no surprise activations
// mid-journal-entry" experience.
clientsClaim();

self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}
});

// ============================================================================
// PRECACHE
// ============================================================================
// `self.__WB_MANIFEST` is replaced at build time by vite-plugin-pwa with
// the list of precache assets (JS/CSS/HTML/icons per the globPatterns in
// vite.config.ts injectManifest).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ============================================================================
// SPA NAVIGATION FALLBACK
// ============================================================================
// Any route under /Mirror/* that isn't a real file should fall back to the
// cached index.html. Workbox v7 expects us to register a NavigationRoute
// that pulls from the precache.
//
// Deny-list: never serve cached HTML for API or WebSocket upgrade paths.
import { createHandlerBoundToURL } from 'workbox-precaching';
const navigationHandler = createHandlerBoundToURL('/Mirror/index.html');
registerRoute(
	new NavigationRoute(navigationHandler, {
		denylist: [/^\/mirror\/api\//, /^\/mirror\/groups\/chat/],
	}),
);

// ============================================================================
// RUNTIME CACHING
// ============================================================================
// JS/CSS chunks under /Mirror/assets/* — vite emits content-hashed
// filenames (index-XXXX.js), so each file is immutable per build.
// CacheFirst is the right strategy: hit on every repeat visit / offline
// load, only refetched when a new deploy emits a new hash. The
// ExpirationPlugin auto-evicts old hashes as new ones arrive.
//
// This is what allows us to keep the giant main bundle OUT of precache
// (where Workbox's size-limit machinery would complain) without
// losing offline support: first visit downloads + caches the bundle,
// subsequent visits serve from cache, offline launches do the same.
registerRoute(
	({ url, request }) =>
		url.pathname.startsWith('/Mirror/assets/') &&
		(request.destination === 'script' || request.destination === 'style'),
	new CacheFirst({
		cacheName: 'mirror-assets',
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 30,
				maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
				purgeOnQuotaError: true,
			}),
		],
	}),
);

// face-api ML models (216 MB total, served from /Mirror/models/faceapi/).
// Files have no extension (e.g. tiny_face_detector_model-shard1) so we
// match by URL path. Each shard is content-stable per name → CacheFirst.
registerRoute(
	({ url }) => url.pathname.startsWith('/Mirror/models/faceapi/'),
	new CacheFirst({
		cacheName: 'mirror-faceapi-models',
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 30,
				maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
				purgeOnQuotaError: true,
			}),
		],
	}),
);

// IQ test reference images (SVGs).
registerRoute(
	({ url }) => url.pathname.startsWith('/Mirror/images/iq/'),
	new CacheFirst({
		cacheName: 'mirror-iq-images',
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 50,
				maxAgeSeconds: 60 * 60 * 24 * 30,
			}),
		],
	}),
);

// Google Fonts CSS.
registerRoute(
	({ url }) => url.origin === 'https://fonts.googleapis.com',
	new StaleWhileRevalidate({
		cacheName: 'google-fonts-css',
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 10,
				maxAgeSeconds: 60 * 60 * 24 * 7,
			}),
		],
	}),
);

// Google Fonts files.
registerRoute(
	({ url }) => url.origin === 'https://fonts.gstatic.com',
	new CacheFirst({
		cacheName: 'google-fonts-files',
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 30,
				maxAgeSeconds: 60 * 60 * 24 * 365,
			}),
		],
	}),
);

// Mirror API GETs — NetworkFirst with 3s timeout. POST/PUT/DELETE bypass
// the SW because the matcher only returns true for GET.
registerRoute(
	({ url, request }) =>
		request.method === 'GET' && url.pathname.startsWith('/mirror/api/'),
	new NetworkFirst({
		cacheName: 'mirror-api',
		networkTimeoutSeconds: 3,
		plugins: [
			new CacheableResponsePlugin({ statuses: [0, 200] }),
			new ExpirationPlugin({
				maxEntries: 100,
				maxAgeSeconds: 60 * 60 * 24,
			}),
		],
	}),
	'GET',
);

// ============================================================================
// CATCH-ALL FALLBACK
// ============================================================================
// If all of the above strategies fail (e.g. truly offline + nothing in
// cache for an asset Workbox wasn't told about), this returns a cached
// shell for navigations and a generic Response otherwise.
setCatchHandler(async ({ request }) => {
	if (request.destination === 'document') {
		const cache = await caches.open('workbox-precache-v2-https://www.theundergroundrailroad.world/Mirror/');
		const fallback = await cache.match('/Mirror/index.html');
		if (fallback) return fallback;
	}
	return Response.error();
});

// ============================================================================
// PUSH PAYLOAD SHAPE
// ============================================================================
// Mirrors the server's PushPayload (services/pushService.ts). Kept tiny —
// push services cap encrypted payloads at ~4096 B; we cap raw at 3000 B.
//
// Optional `unreadCount` lets the SW set the OS-level app icon badge (iOS
// 16.4+, Chrome, Edge, Opera). Falls back silently on unsupported platforms.
interface PushPayload {
	title: string;
	body: string;
	url?: string;
	tag?: string;
	icon?: string;
	badge?: string;
	data?: Record<string, unknown>;
	unreadCount?: number;
	requireInteraction?: boolean;
	silent?: boolean;
	renotify?: boolean;
}

const DEFAULT_ICON = '/Mirror/pwa-192x192.png';
const DEFAULT_BADGE = '/Mirror/pwa-192x192.png'; // Should be a small monochrome PNG; reusing main icon for now.
const DEFAULT_TITLE = 'Mirror';
const DEFAULT_BODY = 'You have a new notification.';

function safeParsePayload(event: PushEvent): PushPayload {
	if (!event.data) {
		return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
	}
	try {
		const parsed = event.data.json() as Partial<PushPayload>;
		return {
			title: typeof parsed.title === 'string' && parsed.title ? parsed.title : DEFAULT_TITLE,
			body: typeof parsed.body === 'string' && parsed.body ? parsed.body : DEFAULT_BODY,
			url: typeof parsed.url === 'string' ? parsed.url : undefined,
			tag: typeof parsed.tag === 'string' ? parsed.tag : undefined,
			icon: typeof parsed.icon === 'string' ? parsed.icon : undefined,
			badge: typeof parsed.badge === 'string' ? parsed.badge : undefined,
			data: parsed.data && typeof parsed.data === 'object' ? parsed.data : undefined,
			unreadCount:
				typeof parsed.unreadCount === 'number' && parsed.unreadCount >= 0
					? parsed.unreadCount
					: undefined,
			requireInteraction: !!parsed.requireInteraction,
			silent: !!parsed.silent,
			renotify: !!parsed.renotify,
		};
	} catch {
		// Last-ditch: try .text() so we still surface SOMETHING to the user
		// rather than failing silently if the payload isn't valid JSON.
		try {
			const text = event.data.text();
			return { title: DEFAULT_TITLE, body: text.slice(0, 200) || DEFAULT_BODY };
		} catch {
			return { title: DEFAULT_TITLE, body: DEFAULT_BODY };
		}
	}
}

// ============================================================================
// APP BADGE
// ============================================================================
// navigator.setAppBadge / clearAppBadge land on the SW's WorkerNavigator.
// Wrapped in try/catch because the call can throw on some browsers when the
// PWA isn't installed or the count is invalid.
async function updateBadge(count: number | undefined): Promise<void> {
	const nav = self.navigator as Navigator & {
		setAppBadge?: (count: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
	if (!nav.setAppBadge) return;
	try {
		if (typeof count === 'number' && count > 0) {
			await nav.setAppBadge(count);
		} else if (count === 0 && nav.clearAppBadge) {
			await nav.clearAppBadge();
		}
	} catch {
		// Badging is polish, never block notification display.
	}
}

// ============================================================================
// PUSH EVENT
// ============================================================================
//
// Phase 6a.5: skip the OS notification when a Mirror window is visible+focused.
// The server already tries to skip push for active users (visibility-tracked
// over WS), but races still happen — the user backgrounds, server fires push
// based on stale visibility, push arrives ~50ms later. The SW catches that
// last-ms case here.
//
// Web Push spec requires `userVisibleOnly: true` subscriptions to result in
// a user-visible notification — most browsers warn but don't revoke if you
// don't show one, but Safari/iOS is stricter. So when we suppress: post the
// payload to the visible client (so the app can render an in-app toast if
// it wants) AND show a `silent: true` notification briefly, then close it.
// This satisfies the spec without buzzing the user mid-use.

async function handlePushEvent(event: PushEvent): Promise<void> {
	const payload = safeParsePayload(event);

	// `renotify` is valid per spec but missing from TS's NotificationOptions
	// type (lib.dom.d.ts hasn't caught up). Cast through unknown to set it.
	const notificationOptions = {
		body: payload.body,
		icon: payload.icon || DEFAULT_ICON,
		badge: payload.badge || DEFAULT_BADGE,
		tag: payload.tag,
		data: {
			url: payload.url,
			...(payload.data || {}),
		},
		requireInteraction: payload.requireInteraction,
		silent: payload.silent,
		renotify: payload.renotify,
	} as unknown as NotificationOptions;

	const visibleClient = await findVisibleClient();
	if (visibleClient) {
		// User is actively in the app — forward to the client for in-app
		// rendering, suppress the OS notification.
		try {
			visibleClient.postMessage({ type: 'PUSH_RECEIVED_WHILE_ACTIVE', payload });
		} catch {
			// non-fatal
		}

		// Spec compliance: still show *something* (silent + auto-close)
		// so userVisibleOnly contract is satisfied. iOS Safari is the
		// strictest enforcer; this dance keeps the subscription healthy.
		const silentOptions = {
			...notificationOptions,
			silent: true,
			requireInteraction: false,
			tag: payload.tag,
		} as unknown as NotificationOptions;

		await self.registration.showNotification(payload.title, silentOptions);
		// Close after a tick. Wrapping the timeout in a Promise so the
		// outer event.waitUntil keeps the SW alive long enough to close.
		// Otherwise on slower devices the SW could be killed mid-tick,
		// leaving the silent notification on screen forever.
		await new Promise<void>((resolve) => {
			setTimeout(async () => {
				try {
					const notifs = await self.registration.getNotifications({ tag: payload.tag });
					notifs.forEach((n) => n.close());
				} catch {
					/* non-fatal */
				}
				resolve();
			}, 100);
		});
		// Update badge regardless — unread count should reflect reality.
		await updateBadge(payload.unreadCount);
		return;
	}

	// No visible client — show the regular OS notification.
	await Promise.all([
		self.registration.showNotification(payload.title, notificationOptions),
		updateBadge(payload.unreadCount),
	]);
}

async function findVisibleClient(): Promise<WindowClient | null> {
	try {
		const all = await self.clients.matchAll({
			type: 'window',
			includeUncontrolled: true,
		});
		for (const c of all) {
			if (c.visibilityState === 'visible' && c.focused) {
				return c as WindowClient;
			}
		}
	} catch {
		// matchAll is broadly supported, but if it ever throws we just
		// fall through and show the notification — better to over-deliver.
	}
	return null;
}

self.addEventListener('push', (event) => {
	// waitUntil keeps the SW alive for the whole show/skip flow.
	event.waitUntil(handlePushEvent(event));
});

// ============================================================================
// NOTIFICATION CLICK
// ============================================================================
// Click handler: focus an existing Mirror tab if one is open, navigating it
// to the deep-link URL if needed. Otherwise open a new window. Falls back
// to the app root if no URL was provided.
self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const data = (event.notification.data || {}) as { url?: string };
	const targetUrl = sanitizeTargetUrl(data.url);

	event.waitUntil(focusOrOpen(targetUrl));
});

/**
 * Only allow same-origin URLs to be navigated to. Defends against a
 * malicious or buggy server sending an off-origin URL in a payload.
 */
function sanitizeTargetUrl(rawUrl: string | undefined): string {
	const fallback = '/Mirror/';
	if (!rawUrl || typeof rawUrl !== 'string') return fallback;

	try {
		const u = new URL(rawUrl, self.location.origin);
		if (u.origin !== self.location.origin) return fallback;
		// Confine deep-links to /Mirror/* so a payload can't point at e.g.
		// /admin or another app on the same origin.
		if (!u.pathname.startsWith('/Mirror/')) return fallback;
		return u.pathname + u.search + u.hash;
	} catch {
		return fallback;
	}
}

async function focusOrOpen(targetUrl: string): Promise<void> {
	const allClients = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});

	// Prefer an existing client. If one is already on the target URL,
	// just focus it. Otherwise focus the first Mirror client and navigate it.
	const targetAbsolute = new URL(targetUrl, self.location.origin).href;

	for (const client of allClients) {
		if (client.url === targetAbsolute) {
			await client.focus();
			return;
		}
	}

	for (const client of allClients) {
		if (
			client.url.startsWith(self.location.origin + '/Mirror/') &&
			'navigate' in client
		) {
			try {
				await (client as WindowClient).navigate(targetUrl);
				await client.focus();
				return;
			} catch {
				// Some browsers reject navigate() across SW versions; fall
				// through to opening a new window.
			}
		}
	}

	// No existing tab → open one.
	if (self.clients.openWindow) {
		await self.clients.openWindow(targetUrl);
	}
}

// ============================================================================
// PUSH SUBSCRIPTION CHANGE
// ============================================================================
// Fires when the browser invalidates and re-issues a push subscription
// (rare — usually after a token rotation, profile change, or extended
// inactivity). The new subscription must be POSTed to the server; the
// old one is gone. Without handling this, users would silently stop
// receiving pushes.
//
// The SW can't reach our auth token directly — instead we ping any open
// client to take care of re-subscribing. If no client is open, the next
// time the user opens the app, the in-app subscribe flow will detect the
// missing record on the server and re-subscribe.
// TypeScript's ServiceWorkerGlobalScopeEventMap doesn't include
// 'pushsubscriptionchange' (lib.webworker.d.ts gap), so the handler arg
// gets typed as Event without waitUntil. Cast to ExtendableEvent — the
// runtime type is PushSubscriptionChangeEvent which IS extendable.
self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent) => {
	event.waitUntil(notifyClientsOfSubscriptionChange());
}) as EventListener);

async function notifyClientsOfSubscriptionChange(): Promise<void> {
	const allClients = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true,
	});
	for (const client of allClients) {
		client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
	}
}
