// src/services/chatWebSocket.ts
// MirrorGroups Chat WebSocket Service - Real-time chat communication
// Enterprise-grade connection management with robust reconnection,
// dead-connection detection, and mobile lifecycle handling.

import { getToken } from '../utils/token';
import type {
  ChatWSMessageType,
  ChatWSMessage,
  WSGroupJoinedPayload,
  WSSendMessagePayload,
  WSMessageAckPayload,
  WSNewMessagePayload,
  WSMessageEditedPayload,
  WSMessageDeletedPayload,
  WSTypingPayload,
  WSPresencePayload,
  WSReactionsUpdatedPayload,
  WSMessageReadPayload,
  WSMentionPayload,
  WSErrorPayload,
  MessageContentType,
  PresenceStatus,
  MessageMetadata,
} from '../types/chat';
import { CHAT_CONFIG } from '../types/chat';

// ============================================================================
// CONFIGURATION
// ============================================================================

const WS_BASE = import.meta.env.VITE_WS_URL
  ? import.meta.env.VITE_WS_URL
  : import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

const WS_ENDPOINT = `${WS_BASE}/mirror/groups/chat`;

// Reconnection: base delays with jitter applied at runtime
const BASE_RECONNECT_DELAYS = CHAT_CONFIG.RECONNECT_DELAYS;
const HEARTBEAT_INTERVAL = CHAT_CONFIG.HEARTBEAT_INTERVAL;
const HEARTBEAT_TIMEOUT = CHAT_CONFIG.HEARTBEAT_TIMEOUT;
const MAX_RECONNECT_ATTEMPTS = 50;
const MAX_PENDING_MESSAGES = 200;

// Close codes that should NOT trigger reconnection
const NON_RECOVERABLE_CODES = new Set([
  1000, // Normal closure
  1008, // Policy violation (auth rejected by server)
  4001, // Authentication failed
  4003, // Forbidden
]);

// ============================================================================
// HELPERS
// ============================================================================

/** Add +/-25% jitter to a delay to prevent thundering herd on server restart */
function withJitter(baseDelay: number): number {
  const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(baseDelay + jitter));
}

/** Detect mobile device for device parameter sent to server */
function detectDeviceType(): string {
  if (typeof navigator === 'undefined') return 'web';
  return /Mobile|Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) ? 'mobile' : 'web';
}

/** Structured log helper */
function wsLog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
  const prefix = '[ChatWS]';
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  if (level === 'error') console.error(`${prefix} ${msg}${extra}`);
  else if (level === 'warn') console.warn(`${prefix} ${msg}${extra}`);
  else console.log(`${prefix} ${msg}${extra}`);
}

// ============================================================================
// EVENT TYPES
// ============================================================================

type EventHandler<T = unknown> = (data: T) => void;
type ErrorHandler = (error: Error) => void;
type ConnectionHandler = (connected: boolean) => void;

interface ChatEventHandlers {
  // Connection events
  onConnect: ConnectionHandler[];
  onDisconnect: ConnectionHandler[];
  onError: ErrorHandler[];

  // Message events
  'chat:message': EventHandler<WSNewMessagePayload>[];
  'chat:message_edited': EventHandler<WSMessageEditedPayload>[];
  'chat:message_deleted': EventHandler<WSMessageDeletedPayload>[];
  'chat:ack': EventHandler<WSMessageAckPayload>[];

  // Typing events
  'chat:typing': EventHandler<WSTypingPayload>[];

  // Presence events
  'chat:presence': EventHandler<WSPresencePayload>[];

  // Reaction events
  'chat:reactions_updated': EventHandler<WSReactionsUpdatedPayload>[];

  // Read receipt events
  'chat:message_read': EventHandler<WSMessageReadPayload>[];

  // Mention events
  'chat:mention': EventHandler<WSMentionPayload>[];

  // Group events
  'chat:group_joined': EventHandler<WSGroupJoinedPayload>[];
  'chat:group_left': EventHandler<{ groupId: string }>[];

  // Error events
  'chat:error': EventHandler<WSErrorPayload>[];

  // Dina AI events
  'dina:processing_start': EventHandler[];
  'dina:stream_start': EventHandler[];
  'dina:stream_chunk': EventHandler[];
  'dina:stream_complete': EventHandler[];
}

type ChatEventType = keyof Omit<ChatEventHandlers, 'onConnect' | 'onDisconnect' | 'onError'>;

// ============================================================================
// PENDING REQUEST MANAGEMENT
// ============================================================================

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ============================================================================
// WEBSOCKET CLIENT CLASS
// ============================================================================

class ChatWebSocketClient {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;
  private subscribedGroups: Set<string> = new Set();
  private pendingMessages: Array<{ type: string; payload: unknown; requestId?: string }> = [];
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private typingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastConnectedAt = 0;
  private visibilityHandler: (() => void) | null = null;

  private handlers: ChatEventHandlers = {
    onConnect: [],
    onDisconnect: [],
    onError: [],
    'chat:message': [],
    'chat:message_edited': [],
    'chat:message_deleted': [],
    'chat:ack': [],
    'chat:typing': [],
    'chat:presence': [],
    'chat:reactions_updated': [],
    'chat:message_read': [],
    'chat:mention': [],
    'chat:group_joined': [],
    'chat:group_left': [],
    'chat:error': [],
    'dina:processing_start': [],
    'dina:stream_start': [],
    'dina:stream_chunk': [],
    'dina:stream_complete': [],
  };

  // ==================== CONNECTION MANAGEMENT ====================

  connect(): void {
    // Guard: already open
    if (this.socket?.readyState === WebSocket.OPEN) {
      wsLog('info', 'Already connected, skipping');
      return;
    }

    // Guard: connection in progress - don't create duplicate sockets
    if (this.socket?.readyState === WebSocket.CONNECTING) {
      wsLog('info', 'Connection already in progress, skipping');
      return;
    }

    const token = getToken();
    if (!token) {
      wsLog('warn', 'No auth token available, cannot connect');
      return;
    }

    this.isManualDisconnect = false;

    // Clean up any stale socket before creating a new one
    this.destroySocket();

    try {
      const device = detectDeviceType();
      const url = `${WS_ENDPOINT}?token=${encodeURIComponent(token)}&device=${device}`;
      wsLog('info', 'Connecting', { endpoint: WS_ENDPOINT, device, attempt: this.reconnectAttempts });

      this.socket = new WebSocket(url);
      this.setupSocketHandlers();
      this.setupVisibilityHandler();
    } catch (error) {
      wsLog('error', 'Failed to create WebSocket', { error: String(error) });
      this.handleError(new Error(`Connection creation failed: ${String(error)}`));
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    wsLog('info', 'Manual disconnect requested');
    this.isManualDisconnect = true;
    this.cleanup();
    this.teardownVisibilityHandler();

    if (this.socket) {
      try {
        if (this.socket.readyState === WebSocket.OPEN ||
            this.socket.readyState === WebSocket.CONNECTING) {
          this.socket.close(1000, 'Client disconnect');
        }
      } catch {
        // Socket may already be in a broken state
      }
      this.socket = null;
    }

    this.subscribedGroups.clear();
    this.clearAllTypingTimers();
    this.rejectAllPendingRequests('Connection closed by client');
    this.pendingMessages = [];
    this.reconnectAttempts = 0;
    this.notifyDisconnect();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  getConnectionState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  /** Tear down socket event handlers and null the reference */
  private destroySocket(): void {
    if (!this.socket) return;
    try {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      if (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(1000, 'Replacing connection');
      }
    } catch {
      // Ignore errors during teardown
    }
    this.socket = null;
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.onopen = () => {
      this.lastConnectedAt = Date.now();
      this.reconnectAttempts = 0;
      wsLog('info', 'Connected successfully');

      this.startHeartbeat();
      this.notifyConnect();

      // Resubscribe to previously subscribed groups
      this.subscribedGroups.forEach((groupId) => {
        this.sendMessage('chat:join_group', { groupId });
      });

      // Drain pending message queue
      this.drainPendingMessages();
    };

    this.socket.onclose = (event) => {
      const sessionDuration = this.lastConnectedAt
        ? Math.round((Date.now() - this.lastConnectedAt) / 1000)
        : 0;

      wsLog('info', 'Connection closed', {
        code: event.code,
        reason: event.reason || '(none)',
        wasClean: event.wasClean,
        sessionSeconds: sessionDuration,
      });

      this.cleanup();
      this.notifyDisconnect();

      // Decide whether to reconnect based on close code
      if (this.isManualDisconnect) {
        wsLog('info', 'Manual disconnect - will not reconnect');
        return;
      }

      if (NON_RECOVERABLE_CODES.has(event.code)) {
        wsLog('warn', 'Non-recoverable close code, will not auto-reconnect', { code: event.code });
        if (event.code === 4001 || event.code === 1008) {
          this.handleError(new Error(`Authentication rejected (code ${event.code})`));
        }
        return;
      }

      this.scheduleReconnect();
    };

    this.socket.onerror = (_event) => {
      // The error event fires BEFORE close, so we log but don't reconnect here.
      // Reconnection is handled in onclose to prevent duplicate attempts.
      wsLog('error', 'Socket error occurred (close event will follow)');
      this.handleError(new Error('WebSocket transport error'));
    };

    this.socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  // ==================== VISIBILITY LIFECYCLE ====================

  private setupVisibilityHandler(): void {
    if (this.visibilityHandler) return;

    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.isManualDisconnect) return;

      if (!this.isConnected()) {
        wsLog('info', 'Page visible, connection lost while backgrounded - reconnecting');
        this.reconnectAttempts = 0;
        this.cleanup();
        this.connect();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private teardownVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  // ==================== MESSAGE HANDLING ====================

  private handleMessage(data: string): void {
    try {
      const message: ChatWSMessage = JSON.parse(data);

      // Handle pong (application-level heartbeat response)
      if (message.type === 'pong') {
        this.clearHeartbeatTimeout();
        return;
      }

      // Handle connection confirmation
      if ((message.type as string) === 'chat:connection_established') {
        wsLog('info', 'Server confirmed connection', { payload: message.payload });
        return;
      }

      // Defense-in-depth ack routing.
      //
      // Resolve / reject ANY pending request whose requestId matches this
      // message — regardless of the message's `type`. Historically only
      // `chat:ack` was honoured here, which silently broke join/leave
      // (server replied with `chat:group_joined` / `chat:group_left`
      // carrying the requestId) and is fragile against any future
      // protocol drift. Errors still reject; everything else resolves.
      //
      // We DO NOT return after resolving — semantic handlers below should
      // still fire for the corresponding event type (e.g.
      // `chat:group_joined` listeners updating UI badges).
      if (message.requestId) {
        const pending = this.pendingRequests.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.requestId);
          if (message.type === 'chat:error') {
            pending.reject(new Error((message.payload as WSErrorPayload).error));
          } else {
            pending.resolve(message.payload);
          }
        }
      }

      // Route message to appropriate handlers
      const eventType = message.type as ChatEventType;
      const handlers = this.handlers[eventType];

      if (Array.isArray(handlers)) {
        handlers.forEach((handler) => {
          try {
            (handler as EventHandler)(message.payload);
          } catch (err) {
            wsLog('error', `Handler threw for event "${eventType}"`, { error: String(err) });
          }
        });
      }
    } catch (error) {
      wsLog('error', 'Failed to parse incoming message', { error: String(error) });
    }
  }

  private handleError(error: Error): void {
    this.handlers.onError.forEach((handler) => {
      try {
        handler(error);
      } catch (err) {
        wsLog('error', 'Error handler threw', { error: String(err) });
      }
    });
  }

  private notifyConnect(): void {
    this.handlers.onConnect.forEach((handler) => {
      try {
        handler(true);
      } catch (err) {
        wsLog('error', 'Connect handler threw', { error: String(err) });
      }
    });
  }

  private notifyDisconnect(): void {
    this.handlers.onDisconnect.forEach((handler) => {
      try {
        handler(false);
      } catch (err) {
        wsLog('error', 'Disconnect handler threw', { error: String(err) });
      }
    });
  }

  // ==================== RECONNECTION WITH JITTER ====================

  private scheduleReconnect(): void {
    // Guard: already have a reconnect scheduled
    if (this.reconnectTimer) return;

    // Guard: exceeded max attempts
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      wsLog('error', 'Max reconnection attempts reached, giving up', {
        attempts: this.reconnectAttempts,
        max: MAX_RECONNECT_ATTEMPTS,
      });
      this.handleError(new Error(`Connection lost after ${this.reconnectAttempts} reconnection attempts`));
      return;
    }

    const baseDelay = BASE_RECONNECT_DELAYS[
      Math.min(this.reconnectAttempts, BASE_RECONNECT_DELAYS.length - 1)
    ];
    const delay = withJitter(baseDelay);

    wsLog('info', 'Scheduling reconnect', {
      attempt: this.reconnectAttempts + 1,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  // ==================== HEARTBEAT ====================

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.sendMessage('ping', {});
        this.setHeartbeatTimeout();
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private setHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
    this.heartbeatTimeout = setTimeout(() => {
      wsLog('warn', 'Heartbeat pong not received within timeout, closing connection', {
        timeoutMs: HEARTBEAT_TIMEOUT,
      });
      try {
        this.socket?.close(4000, 'Heartbeat timeout');
      } catch {
        this.destroySocket();
        this.cleanup();
        this.notifyDisconnect();
        this.scheduleReconnect();
      }
    }, HEARTBEAT_TIMEOUT);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ==================== MESSAGING ====================

  private sendMessage(type: ChatWSMessageType | 'ping', payload: unknown, requestId?: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      // Queue message for later if not connected (never queue pings)
      if (type !== 'ping') {
        if (this.pendingMessages.length >= MAX_PENDING_MESSAGES) {
          const dropped = this.pendingMessages.shift();
          wsLog('warn', 'Pending message queue full, dropped oldest message', {
            droppedType: dropped?.type,
            queueSize: MAX_PENDING_MESSAGES,
          });
        }
        this.pendingMessages.push({ type, payload, requestId });
      }
      return false;
    }

    try {
      const message: ChatWSMessage = {
        type: type as ChatWSMessageType,
        payload,
        requestId,
        timestamp: new Date().toISOString(),
      };
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      wsLog('error', 'Send failed', { type, error: String(error) });
      return false;
    }
  }

  private drainPendingMessages(): void {
    const batch = this.pendingMessages.splice(0);
    let sent = 0;
    for (const msg of batch) {
      if (this.sendMessage(msg.type as ChatWSMessageType, msg.payload, msg.requestId)) {
        sent++;
      }
    }
    if (sent > 0) {
      wsLog('info', 'Drained pending message queue', { sent, total: batch.length });
    }
  }

  private sendWithAck<T>(
    type: ChatWSMessageType,
    payload: unknown,
    timeout: number = 10000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();

      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout after ${timeout}ms for ${type}`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout: timeoutHandle,
      });

      if (!this.sendMessage(type, payload, requestId)) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to send ${type}: socket not open`));
      }
    });
  }

  private rejectAllPendingRequests(reason: string): void {
    this.pendingRequests.forEach((pending, requestId) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(requestId);
    });
  }

  // ==================== GROUP SUBSCRIPTIONS ====================

  joinGroup(groupId: string): Promise<WSGroupJoinedPayload> {
    this.subscribedGroups.add(groupId);

    if (this.isConnected()) {
      return this.sendWithAck<WSGroupJoinedPayload>('chat:join_group', { groupId });
    }

    return Promise.resolve({ groupId, subscriberCount: 0 });
  }

  leaveGroup(groupId: string): void {
    this.subscribedGroups.delete(groupId);
    this.clearTypingTimer(groupId);

    if (this.isConnected()) {
      this.sendMessage('chat:leave_group', { groupId });
    }
  }

  // ==================== CHAT ACTIONS ====================

  sendChatMessage(
    groupId: string,
    content: string,
    options: {
      contentType?: MessageContentType;
      parentMessageId?: string;
      clientMessageId?: string;
      metadata?: Partial<MessageMetadata>;
    } = {}
  ): Promise<WSMessageAckPayload> {
    const payload: WSSendMessagePayload = {
      groupId,
      content,
      contentType: options.contentType || 'text',
      parentMessageId: options.parentMessageId,
      clientMessageId: options.clientMessageId || crypto.randomUUID(),
      metadata: options.metadata,
    };

    return this.sendWithAck<WSMessageAckPayload>('chat:send_message', payload);
  }

  editChatMessage(groupId: string, messageId: string, content: string): Promise<WSMessageAckPayload> {
    return this.sendWithAck<WSMessageAckPayload>('chat:edit_message', {
      groupId,
      messageId,
      content,
    });
  }

  deleteChatMessage(groupId: string, messageId: string): Promise<WSMessageAckPayload> {
    return this.sendWithAck<WSMessageAckPayload>('chat:delete_message', {
      groupId,
      messageId,
    });
  }

  // ==================== TYPING INDICATORS ====================

  private clearTypingTimer(groupId: string): void {
    const timer = this.typingTimers.get(groupId);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(groupId);
    }
  }

  private clearAllTypingTimers(): void {
    this.typingTimers.forEach((timer) => clearTimeout(timer));
    this.typingTimers.clear();
  }

  startTyping(groupId: string): void {
    // Clear any existing timer
    this.clearTypingTimer(groupId);

    // Send typing start
    this.sendMessage('chat:typing_start', { groupId });

    // Auto-stop after 5 seconds
    const timer = setTimeout(() => {
      this.stopTyping(groupId);
    }, 5000);

    this.typingTimers.set(groupId, timer);
  }

  stopTyping(groupId: string): void {
    this.clearTypingTimer(groupId);
    this.sendMessage('chat:typing_stop', { groupId });
  }

  // ==================== PRESENCE ====================

  updatePresence(groupId: string, status: PresenceStatus, deviceType?: string): void {
    this.sendMessage('chat:presence_update', {
      groupId,
      status,
      deviceType,
    });
  }

  // ==================== READ RECEIPTS ====================

  markRead(groupId: string, messageId: string): void {
    this.sendMessage('chat:mark_read', {
      groupId,
      messageId,
    });
  }

  // ==================== REACTIONS ====================

  addReaction(groupId: string, messageId: string, emoji: string): void {
    this.sendMessage('chat:add_reaction', {
      groupId,
      messageId,
      emoji,
    });
  }

  removeReaction(groupId: string, messageId: string, emoji: string): void {
    this.sendMessage('chat:remove_reaction', {
      groupId,
      messageId,
      emoji,
    });
  }

  // ==================== EVENT HANDLERS ====================

  onConnect(handler: ConnectionHandler): () => void {
    this.handlers.onConnect.push(handler);
    return () => {
      const idx = this.handlers.onConnect.indexOf(handler);
      if (idx >= 0) this.handlers.onConnect.splice(idx, 1);
    };
  }

  onDisconnect(handler: ConnectionHandler): () => void {
    this.handlers.onDisconnect.push(handler);
    return () => {
      const idx = this.handlers.onDisconnect.indexOf(handler);
      if (idx >= 0) this.handlers.onDisconnect.splice(idx, 1);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.handlers.onError.push(handler);
    return () => {
      const idx = this.handlers.onError.indexOf(handler);
      if (idx >= 0) this.handlers.onError.splice(idx, 1);
    };
  }

  on<K extends ChatEventType>(event: K, handler: EventHandler): () => void {
    const handlers = this.handlers[event];
    if (Array.isArray(handlers)) {
      handlers.push(handler as EventHandler);
      return () => {
        const idx = handlers.indexOf(handler as EventHandler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    }
    return () => {};
  }

  off<K extends ChatEventType>(event: K, handler: EventHandler): void {
    const handlers = this.handlers[event];
    if (Array.isArray(handlers)) {
      const idx = handlers.indexOf(handler as EventHandler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  offAll<K extends keyof ChatEventHandlers>(event: K): void {
    if (event in this.handlers) {
      (this.handlers[event] as unknown[]).length = 0;
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE & EXPORTS
// ============================================================================

const chatWebSocket = new ChatWebSocketClient();

// Connection management
export const connectChatWebSocket = () => chatWebSocket.connect();
export const disconnectChatWebSocket = () => chatWebSocket.disconnect();
export const isChatWebSocketConnected = () => chatWebSocket.isConnected();
export const getChatConnectionState = () => chatWebSocket.getConnectionState();

// Group subscriptions
export const joinChatGroup = (groupId: string) => chatWebSocket.joinGroup(groupId);
export const leaveChatGroup = (groupId: string) => chatWebSocket.leaveGroup(groupId);

// Chat actions
export const sendChatMessageWS = (
  groupId: string,
  content: string,
  options?: {
    contentType?: MessageContentType;
    parentMessageId?: string;
    clientMessageId?: string;
    metadata?: Partial<MessageMetadata>;
  }
) => chatWebSocket.sendChatMessage(groupId, content, options);
export const editChatMessageWS = (groupId: string, messageId: string, content: string) =>
  chatWebSocket.editChatMessage(groupId, messageId, content);
export const deleteChatMessageWS = (groupId: string, messageId: string) =>
  chatWebSocket.deleteChatMessage(groupId, messageId);

// Typing indicators
export const startChatTyping = (groupId: string) => chatWebSocket.startTyping(groupId);
export const stopChatTyping = (groupId: string) => chatWebSocket.stopTyping(groupId);

// Presence
export const updateChatPresence = (groupId: string, status: PresenceStatus, deviceType?: string) =>
  chatWebSocket.updatePresence(groupId, status, deviceType);

// Read receipts
export const markChatRead = (groupId: string, messageId: string) =>
  chatWebSocket.markRead(groupId, messageId);

// Reactions
export const addChatReaction = (groupId: string, messageId: string, emoji: string) =>
  chatWebSocket.addReaction(groupId, messageId, emoji);
export const removeChatReaction = (groupId: string, messageId: string, emoji: string) =>
  chatWebSocket.removeReaction(groupId, messageId, emoji);

// Event handlers
export const onChatConnect = (handler: ConnectionHandler) => chatWebSocket.onConnect(handler);
export const onChatDisconnect = (handler: ConnectionHandler) => chatWebSocket.onDisconnect(handler);
export const onChatError = (handler: ErrorHandler) => chatWebSocket.onError(handler);
export const onChatEvent = <K extends ChatEventType>(event: K, handler: EventHandler) =>
  chatWebSocket.on(event, handler);
export const offChatEvent = <K extends ChatEventType>(event: K, handler: EventHandler) =>
  chatWebSocket.off(event, handler);

// Export instance for advanced usage
export { chatWebSocket };
