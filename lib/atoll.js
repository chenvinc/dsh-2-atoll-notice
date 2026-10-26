/**
 * @file Atoll transport for the `dsh-2-atoll-notice` plugin.
 *
 * Owns a WebSocket connection to the Atoll macOS app and mirrors one dynamic
 * island "live activity" onto it. Protocol: JSON-RPC 2.0 over text frames,
 * one JSON object per frame, default endpoint `ws://127.0.0.1:9020`.
 *
 * Design rules (see `docs/CONTRACT.md` and `docs/PROTOCOL.md`):
 *
 * - The first request on every connection is `atoll.requestAuthorization`
 *   with our `bundleIdentifier`; Atoll binds the connection identity from it.
 * - `show()` only records the desired descriptor. A coalescing timer flushes it
 *   at most every `coalesceMs`, sending `present` for a new activity and
 *   `update` for one that is already presented. `show(null)` dismisses.
 * - Updating an activity Atoll no longer knows about fails with `-32004`;
 *   `present` is then sent as the safe recovery (Atoll upserts by `id`).
 * - Atoll forgets activities when the socket drops, so a successful
 *   (re)authorization replays the desired descriptor.
 * - Public methods never throw and never return rejected promises. Every
 *   failure is reported through `logger.warn` (when supplied) and the
 *   `lastError` field of `state()`.
 *
 * The class has no imports and touches no DOM, so it runs in Node (>= 20, which
 * exposes `WebSocket` as a global) and in browsers alike. A WebSocket factory
 * can be injected for tests via the `webSocket` option.
 */

/** Default Atoll RPC endpoint (loopback only; Atoll binds 127.0.0.1 and ::1). */
const DEFAULT_URL = 'ws://127.0.0.1:9020';
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_COALESCE_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_FLASH_MS = 6_000;

/** JSON-RPC error code returned by Atoll when an activity id is unknown. */
const CODE_ACTIVITY_NOT_FOUND = -32004;
/** JSON-RPC error code returned by Atoll when the request is not authorized. */
const CODE_UNAUTHORIZED = -32001;
/** JSON-RPC error code returned by Atoll when its activity capacity is full. */
const CODE_CAPACITY_EXCEEDED = -32003;

/**
 * @typedef {object} AtollDescriptor
 * @property {string} id                Activity identifier, stable per activity (`dsh-status`).
 * @property {string} [bundleIdentifier] Sending extension's bundle id.
 * @property {string} [title]           Primary line.
 * @property {string} [subtitle]        Secondary line.
 * @property {object} [leadingIcon]     `{ type: 'symbol', name, size }` envelope.
 * @property {object} [trailingContent] `{ type: 'text', text }` envelope.
 * @property {object} [accentColor]     `{ red, green, blue, alpha }`.
 * @property {string} [priority]        `'high'` or `'normal'`.
 * @property {boolean} [allowsMusicCoexistence]
 * @property {Record<string, string>} [metadata]
 *
 * The descriptor is built by `lib/format.js`; this module treats it as opaque
 * JSON and only reads `id`.
 */

/**
 * @typedef {object} AtollClientState
 * @property {boolean} connected   Socket is open.
 * @property {boolean} authorized  `atoll.requestAuthorization` answered `true`.
 * @property {string|null} activityId  Activity id currently presented (or null).
 * @property {string|null} lastError   Last failure message, cleared by the next success.
 * @property {number|null} presentedAt Epoch ms of the last successful present/update.
 */

/**
 * @typedef {object} AtollLogger
 * @property {(message: string, ...args: unknown[]) => void} [warn]
 */

/**
 * @typedef {object} AtollClientOptions
 * @property {string} [url]                   Defaults to `ws://127.0.0.1:9020`.
 * @property {string} bundleIdentifier        Identity sent in every request. Required.
 * @property {string} [appName]               Defaults to `bundleIdentifier` (Atoll uses it as the display name).
 * @property {AtollLogger} [logger]           `{ warn() }`; defaults to a no-op logger.
 * @property {(url: string) => object} [webSocket]
 *   WebSocket factory; defaults to `(url) => new WebSocket(url)` using the
 *   global `WebSocket` (Node >= 22/24, browsers). Tests inject a fake.
 * @property {number} [reconnectBaseMs]       First reconnect delay (default 1000).
 * @property {number} [reconnectMaxMs]        Backoff ceiling (default 30000).
 * @property {number} [coalesceMs]            Flush window for `show()` (default 250).
 * @property {number} [requestTimeoutMs]      Per-request timeout (default 5000).
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} A positive finite number, or `fallback`.
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Transport for one Atoll activity.
 *
 * ```js
 * const client = new AtollClient({
 *   bundleIdentifier: 'com.deepseek.dsh.atoll-notice',
 *   logger: { warn: (...args) => console.warn('[atoll]', ...args) },
 * });
 * client.start();
 * client.show(descriptor);      // coalesced present/update
 * client.flash(descriptor, 6000);
 * client.show(null);            // dismiss
 * await client.stop();
 * ```
 *
 * Status changes are observable without polling:
 *
 * ```js
 * const off = client.onStateChange((state) => render(state));
 * // later
 * off();
 * ```
 */
export class AtollClient {
  /** @type {string} */ #url;
  /** @type {string} */ #bundleIdentifier;
  /** @type {string} */ #appName;
  /** @type {AtollLogger} */ #logger;
  /** @type {((url: string) => object)|null} */ #webSocketFactory;
  /** @type {number} */ #reconnectBaseMs;
  /** @type {number} */ #reconnectMaxMs;
  /** @type {number} */ #coalesceMs;
  /** @type {number} */ #requestTimeoutMs;

  /** @type {any} */ #socket = null;
  /** @type {boolean} */ #open = false;
  /** @type {boolean} */ #started = false;
  /** @type {number} */ #generation = 0;
  /** @type {number} */ #attempt = 0;
  /** @type {any} */ #reconnectTimer = null;
  /** @type {any} */ #coalesceTimer = null;
  /** @type {boolean} */ #flushing = false;
  /** @type {boolean} */ #dirty = false;

  /** @type {AtollDescriptor|null} */ #desired = null;
  /** @type {boolean} */ #desiredSet = false;
  /** @type {string|null} */ #presentedId = null;

  /** @type {boolean} */ #flashActive = false;
  /** @type {AtollDescriptor|null} */ #flashBase = null;
  /** @type {any} */ #flashTimer = null;

  /** @type {number} */ #requestSeq = 0;
  /** @type {Map<string, {resolve: (value: any) => void, timer: any}>} */ #pending = new Map();
  /** @type {Set<(state: AtollClientState) => void>} */ #listeners = new Set();

  /** @type {AtollClientState} */
  #status = {
    connected: false,
    authorized: false,
    activityId: null,
    lastError: null,
    presentedAt: null,
  };

  /**
   * @param {AtollClientOptions} options
   */
  constructor(options = {}) {
    const config = options && typeof options === 'object' ? options : {};
    this.#url = typeof config.url === 'string' && config.url.length > 0 ? config.url : DEFAULT_URL;
    this.#bundleIdentifier = typeof config.bundleIdentifier === 'string' ? config.bundleIdentifier.trim() : '';
    this.#appName =
      typeof config.appName === 'string' && config.appName.length > 0
        ? config.appName
        : this.#bundleIdentifier;
    this.#logger = config.logger && typeof config.logger === 'object' ? config.logger : {};
    this.#webSocketFactory = typeof config.webSocket === 'function' ? config.webSocket : null;
    this.#reconnectBaseMs = positiveNumber(config.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS);
    this.#reconnectMaxMs = Math.max(
      this.#reconnectBaseMs,
      positiveNumber(config.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS),
    );
    this.#coalesceMs =
      typeof config.coalesceMs === 'number' && Number.isFinite(config.coalesceMs) && config.coalesceMs >= 0
        ? config.coalesceMs
        : DEFAULT_COALESCE_MS;
    this.#requestTimeoutMs = positiveNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Start the connect/reconnect loop. Idempotent; safe to call before `start()`.
   * With no `bundleIdentifier` nothing is connected: the problem is reported
   * through `state().lastError` instead of throwing.
   *
   * @returns {void}
   */
  start() {
    try {
      if (this.#started) return;
      if (!this.#bundleIdentifier) {
        this.#fail('AtollClient requires a bundleIdentifier option');
        return;
      }
      this.#started = true;
      this.#attempt = 0;
      this.#connect();
    } catch (error) {
      this.#fail('AtollClient.start failed', error);
    }
  }

  /**
   * Stop the loop and close the socket. Pending requests settle with a
   * `STOPPED` error and no reconnect is scheduled. The last desired descriptor
   * is kept, so a later `start()` presents it again after reauthorizing.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    try {
      this.#started = false;
      this.#generation += 1; // invalidate handlers of the socket being closed
      this.#clearFlash();
      this.#clearTimer('coalesce');
      this.#clearTimer('reconnect');
      this.#dirty = false;
      this.#settlePending({ code: 'STOPPED', message: 'AtollClient stopped' });
      const socket = this.#socket;
      this.#socket = null;
      this.#open = false;
      this.#presentedId = null;
      if (socket && typeof socket.close === 'function') {
        try {
          socket.close(1000, 'client stopped');
        } catch (error) {
          this.#warn('AtollClient stop: socket close failed', error);
        }
      }
      this.#updateStatus({ connected: false, authorized: false, activityId: null, presentedAt: null });
    } catch (error) {
      this.#fail('AtollClient.stop failed', error);
    }
  }

  /**
   * Set the desired activity state. The newest descriptor wins: calls are
   * coalesced and flushed at most once per `coalesceMs`. `null` dismisses the
   * presented activity. The desired state is replayed whenever the connection
   * is (re)authorized, because Atoll forgets activities across sockets.
   *
   * @param {AtollDescriptor|null} descriptor
   * @returns {void}
   */
  show(descriptor) {
    try {
      this.#clearFlash();
      const next = descriptor == null ? null : descriptor;
      this.#desired = next;
      this.#desiredSet = true;
      this.#flashBase = next;
      this.#dirty = true;
      this.#scheduleFlush();
    } catch (error) {
      this.#fail('AtollClient.show failed', error);
    }
  }

  /**
   * Show a temporary descriptor, then restore the last descriptor passed to
   * `show()` (or dismiss when there was none). A second `flash()` replaces the
   * first and keeps the original restore target.
   *
   * @param {AtollDescriptor} descriptor
   * @param {number} [ms] Visible duration in milliseconds (default 6000).
   * @returns {void}
   */
  flash(descriptor, ms = DEFAULT_FLASH_MS) {
    try {
      if (descriptor == null) {
        this.#fail('AtollClient.flash requires a descriptor');
        return;
      }
      if (!this.#flashActive) this.#flashBase = this.#desiredSet ? this.#desired : null;
      this.#flashActive = true;
      this.#desired = descriptor;
      this.#desiredSet = true;
      this.#dirty = true;
      this.#scheduleFlush();
      this.#clearTimer('flash');
      const delay = positiveNumber(ms, DEFAULT_FLASH_MS);
      this.#flashTimer = setTimeout(() => {
        this.#flashTimer = null;
        try {
          if (!this.#flashActive) return;
          this.#flashActive = false;
          const restore = this.#flashBase;
          this.#desired = restore;
          this.#desiredSet = restore != null;
          this.#dirty = true;
          this.#scheduleFlush();
        } catch (error) {
          this.#fail('AtollClient.flash restore failed', error);
        }
      }, Math.round(delay));
    } catch (error) {
      this.#fail('AtollClient.flash failed', error);
    }
  }

  /**
   * Snapshot of the connection/activity status. Safe to call at any time.
   *
   * @returns {AtollClientState}
   */
  state() {
    return { ...this.#status };
  }

  /**
   * Subscribe to status changes. The callback receives a fresh state snapshot
   * and runs synchronously; listener exceptions are swallowed. It fires only
   * when `connected`, `authorized`, `activityId` or `lastError` actually change.
   *
   * @param {(state: AtollClientState) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /** @returns {void} */
  #connect() {
    if (!this.#started) return;
    this.#clearTimer('reconnect');
    const generation = ++this.#generation;
    let socket;
    try {
      socket = this.#createSocket();
    } catch (error) {
      this.#fail('Atoll connection failed', error);
      this.#scheduleReconnect();
      return;
    }
    if (!socket || typeof socket.send !== 'function') {
      this.#fail('Atoll connection failed: WebSocket factory returned no usable socket');
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    this.#open = false;
    this.#updateStatus({ connected: false, authorized: false });

    const guarded = (handler) => (...args) => {
      if (generation !== this.#generation) return;
      try {
        handler(...args);
      } catch (error) {
        this.#fail('Atoll event handler failed', error);
      }
    };

    this.#listen(socket, 'open', guarded(() => this.#handleOpen(generation)));
    this.#listen(socket, 'message', guarded((event) => this.#handleMessage(event)));
    this.#listen(socket, 'close', guarded((event) => this.#handleClose(generation, event)));
    this.#listen(socket, 'error', guarded((event) => this.#handleSocketError(event)));
  }

  /**
   * @returns {any} A WebSocket-like object.
   */
  #createSocket() {
    if (this.#webSocketFactory) return this.#webSocketFactory(this.#url);
    const Ctor = globalThis.WebSocket;
    if (typeof Ctor !== 'function') {
      throw new Error('no global WebSocket available; pass a webSocket factory');
    }
    return new Ctor(this.#url);
  }

  /**
   * Attach an event handler, tolerating both the DOM/Node `addEventListener`
   * API and the older `on<type>` property style.
   *
   * @param {any} socket
   * @param {'open'|'message'|'close'|'error'} type
   * @param {(...args: any[]) => void} handler
   * @returns {void}
   */
  #listen(socket, type, handler) {
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener(type, handler);
      return;
    }
    socket[`on${type}`] = handler;
  }

  /**
   * @param {number} generation
   * @returns {void}
   */
  #handleOpen(generation) {
    this.#open = true;
    this.#updateStatus({ connected: true, authorized: false, lastError: null });
    this.#authorize(generation).catch((error) => this.#fail('Atoll authorization failed', error));
  }

  /**
   * Perform the authorization handshake, then replay the desired descriptor.
   *
   * @param {number} generation
   * @returns {Promise<void>}
   */
  async #authorize(generation) {
    const response = await this.#request('atoll.requestAuthorization', {
      appName: this.#appName,
      bundleIdentifier: this.#bundleIdentifier,
    });
    if (generation !== this.#generation) return;

    if (!response.ok) {
      this.#fail('atoll.requestAuthorization failed', response.error);
      this.#dropSocket();
      return;
    }
    const authorized = Boolean(response.result && response.result.authorized === true);
    if (!authorized) {
      this.#fail('Atoll refused authorization; enable third-party extensions in Atoll');
      this.#dropSocket();
      return;
    }

    this.#attempt = 0;
    this.#presentedId = null; // Atoll forgot every activity when the socket dropped
    this.#updateStatus({ connected: true, authorized: true, activityId: null, presentedAt: null, lastError: null });
    if (this.#desiredSet) this.#scheduleFlush();
  }

  /**
   * Close the current socket after a failed handshake; the close handler
   * schedules the next reconnect.
   *
   * @returns {void}
   */
  #dropSocket() {
    const socket = this.#socket;
    if (!socket || typeof socket.close !== 'function') return;
    try {
      socket.close(1000, 'authorization failed');
    } catch (error) {
      this.#warn('Atoll socket close failed', error);
    }
  }

  /**
   * @param {any} event
   * @returns {void}
   */
  #handleSocketError(event) {
    const message =
      (event && typeof event.message === 'string' && event.message) ||
      (event && event.error && event.error.message) ||
      'Atoll WebSocket error';
    this.#fail(`Atoll WebSocket error: ${message}`);
  }

  /**
   * @param {number} generation
   * @param {any} event
   * @returns {void}
   */
  #handleClose(generation, event) {
    if (generation !== this.#generation) return;
    const wasStarted = this.#started;
    this.#open = false;
    this.#socket = null;
    this.#presentedId = null;
    this.#settlePending({
      code: 'SOCKET_CLOSED',
      message: `Atoll socket closed${event && event.code ? ` (code ${event.code})` : ''}`,
    });
    this.#updateStatus({
      connected: false,
      authorized: false,
      activityId: null,
      presentedAt: null,
    });
    if (wasStarted) this.#scheduleReconnect();
  }

  /** @returns {void} */
  #scheduleReconnect() {
    if (!this.#started || this.#reconnectTimer) return;
    const exponential = Math.min(
      this.#reconnectMaxMs,
      this.#reconnectBaseMs * 2 ** Math.min(this.#attempt, 30),
    );
    const jitter = 0.8 + Math.random() * 0.4; // +/-20%
    const delay = Math.max(1, Math.min(this.#reconnectMaxMs, Math.round(exponential * jitter)));
    this.#attempt = Math.min(this.#attempt + 1, 30);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#started) return;
      try {
        this.#connect();
      } catch (error) {
        this.#fail('Atoll reconnect failed', error);
        this.#scheduleReconnect();
      }
    }, delay);
    // Do not keep a host process alive just to retry a notification socket.
    if (this.#reconnectTimer && typeof this.#reconnectTimer.unref === 'function') {
      this.#reconnectTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Coalesced state flushing
  // -------------------------------------------------------------------------

  /** @returns {void} */
  #scheduleFlush() {
    if (!this.#started || !this.#open || !this.#status.authorized) return;
    if (this.#coalesceTimer) return;
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = null;
      this.#flush().catch((error) => this.#fail('Atoll flush failed', error));
    }, this.#coalesceMs);
  }

  /**
   * Send the current desired state. Runs at most one request at a time; the
   * newest descriptor is always the one sent.
   *
   * @returns {Promise<void>}
   */
  async #flush() {
    if (!this.#started) return;
    if (this.#flushing) {
      this.#dirty = true;
      return;
    }
    if (!this.#open || !this.#status.authorized) return; // keep desired pending
    this.#flushing = true;
    this.#dirty = false;
    try {
      const desired = this.#desiredSet ? this.#desired : null;
      if (desired == null) {
        await this.#dismiss();
      } else {
        await this.#apply(desired);
      }
    } catch (error) {
      this.#fail('Atoll flush failed', error);
    } finally {
      this.#flushing = false;
      if (this.#dirty && this.#open && this.#status.authorized) this.#scheduleFlush();
    }
  }

  /**
   * Present a new activity or update the one already presented.
   *
   * @param {AtollDescriptor} descriptor
   * @returns {Promise<void>}
   */
  async #apply(descriptor) {
    const id = descriptor && typeof descriptor.id === 'string' ? descriptor.id : '';
    if (!id) {
      this.#fail('Atoll descriptor is missing a string id');
      return;
    }
    if (this.#presentedId === id) {
      const response = await this.#request('atoll.updateLiveActivity', { descriptor });
      if (response.ok) {
        this.#markPresented(id);
        return;
      }
      const code = this.#errorCode(response);
      if (code === CODE_ACTIVITY_NOT_FOUND || code === CODE_UNAUTHORIZED) {
        // Atoll no longer knows the activity (restart, dismissal, reconnect
        // race): present again, which upserts by id. An unauthorized update is
        // re-presented once so a recoverable authorization blip self-heals;
        // present re-reports the error if it is not recoverable.
        this.#presentedId = null;
        this.#updateStatus({ activityId: null, presentedAt: null });
        await this.#present(descriptor);
        return;
      }
      if (code === CODE_CAPACITY_EXCEEDED) {
        // Leave the descriptor desired but do not spin: the next coalesced
        // flush (or reconnect) retries.
        this.#fail('Atoll is at capacity; the descriptor stays pending', response.error);
        return;
      }
      this.#fail('atoll.updateLiveActivity failed', response.error);
      return;
    }

    if (this.#presentedId && this.#presentedId !== id) {
      // Only one activity is ours; replace the old one rather than leaking it.
      await this.#dismiss();
    }
    await this.#present(descriptor);
  }

  /**
   * @param {AtollDescriptor} descriptor
   * @returns {Promise<void>}
   */
  async #present(descriptor) {
    const response = await this.#request('atoll.presentLiveActivity', { descriptor });
    if (response.ok) {
      this.#markPresented(descriptor.id);
      return;
    }
    const verb = this.#errorCode(response) === CODE_CAPACITY_EXCEEDED ? 'at capacity' : 'failed';
    this.#fail(`atoll.presentLiveActivity ${verb}`, response.error);
  }

  /** @returns {Promise<void>} */
  async #dismiss() {
    const activityID = this.#presentedId;
    if (!activityID) return;
    const response = await this.#request('atoll.dismissLiveActivity', {
      activityID,
      bundleIdentifier: this.#bundleIdentifier,
    });
    if (response.ok || this.#errorCode(response) === CODE_ACTIVITY_NOT_FOUND) {
      this.#presentedId = null;
      this.#updateStatus({ activityId: null, presentedAt: null, lastError: null });
      return;
    }
    this.#fail('atoll.dismissLiveActivity failed', response.error);
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  #markPresented(id) {
    this.#presentedId = id;
    this.#updateStatus({ activityId: id, presentedAt: Date.now(), lastError: null });
  }

  // -------------------------------------------------------------------------
  // JSON-RPC plumbing
  // -------------------------------------------------------------------------

  /**
   * Send one request and resolve with `{ ok, result?, error? }`. Never rejects.
   *
   * @param {string} method
   * @param {object} params
   * @returns {Promise<{ok: boolean, result?: any, error?: {code?: number|string, message?: string}}>}
   */
  #request(method, params) {
    return new Promise((resolve) => {
      const socket = this.#socket;
      if (!this.#open || !socket || typeof socket.send !== 'function') {
        resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: 'socket is not open' } });
        return;
      }
      // Atoll decodes the request id as a String, so ids must be strings.
      const id = `dsh-${++this.#requestSeq}`;
      let frame;
      try {
        frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id });
      } catch (error) {
        resolve({ ok: false, error: { code: 'ENCODE_FAILED', message: this.#describe(error) } });
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.resolve({
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `${method} timed out after ${this.#requestTimeoutMs}ms`,
          },
        });
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, timer });
      try {
        socket.send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve({ ok: false, error: { code: 'SEND_FAILED', message: this.#describe(error) } });
      }
    });
  }

  /**
   * @param {any} event
   * @returns {void}
   */
  #handleMessage(event) {
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    if (typeof data === 'string') {
      this.#processFrame(data);
      return;
    }
    if (data && typeof data.text === 'function') {
      data.text().then(
        (text) => this.#processFrame(text),
        (error) => this.#warn('Atoll frame could not be read', error),
      );
      return;
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      this.#processFrame(data.toString('utf8'));
      return;
    }
    if (data && data.buffer && typeof TextDecoder === 'function') {
      try {
        this.#processFrame(new TextDecoder().decode(data));
      } catch (error) {
        this.#warn('Atoll frame could not be decoded', error);
      }
      return;
    }
    this.#warn('Atoll sent an unsupported frame payload');
  }

  /**
   * Match a response to its request. Notifications, late responses, unknown ids
   * and malformed JSON are ignored; none of them may throw.
   *
   * @param {string} raw
   * @returns {void}
   */
  #processFrame(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.#warn('Atoll sent a malformed JSON frame; ignoring it');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#warn('Atoll sent a non-object JSON frame; ignoring it');
      return;
    }
    if (message.id === undefined || message.id === null) return; // server notification
    const key = String(message.id);
    const pending = this.#pending.get(key);
    if (!pending) return; // late or unknown response
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    const error = message.error && typeof message.error === 'object' ? message.error : null;
    pending.resolve(
      error
        ? { ok: false, error: { code: error.code, message: error.message } }
        : { ok: true, result: message.result },
    );
  }

  /**
   * Settle every in-flight request with an error.
   *
   * @param {{code: string, message: string}} error
   * @returns {void}
   */
  #settlePending(error) {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
  }

  // -------------------------------------------------------------------------
  // Status bookkeeping
  // -------------------------------------------------------------------------

  /**
   * Merge a patch into the status and notify listeners when a tracked field
   * actually changed. `presentedAt` rides along without causing notifications.
   *
   * @param {Partial<AtollClientState>} patch
   * @returns {void}
   */
  #updateStatus(patch) {
    const previous = this.#status;
    const next = { ...previous, ...patch };
    const changed =
      next.connected !== previous.connected ||
      next.authorized !== previous.authorized ||
      next.activityId !== previous.activityId ||
      next.lastError !== previous.lastError;
    this.#status = next;
    if (!changed) return;
    const snapshot = this.state();
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(snapshot);
      } catch {
        // A status listener must never break the transport.
      }
    }
  }

  /**
   * Record a failure in the log and in `state().lastError`. Never throws.
   *
   * @param {string} message
   * @param {unknown} [error]
   * @returns {void}
   */
  #fail(message, error) {
    const detail =
      error && typeof error === 'object'
        ? [error.code !== undefined ? `(${error.code})` : '', this.#describe(error)]
            .filter(Boolean)
            .join(' ')
        : error
          ? String(error)
          : '';
    const text = detail ? `${message}: ${detail}` : message;
    this.#warn(text);
    this.#updateStatus({ lastError: text });
  }

  /**
   * @param {unknown} error
   * @returns {string}
   */
  #describe(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && typeof error.message === 'string' && error.message) return error.message;
    try {
      return String(error);
    } catch {
      return '';
    }
  }

  /**
   * @param {{ok: boolean, error?: {code?: number|string}}} response
   * @returns {number}
   */
  #errorCode(response) {
    const code = response && response.error ? Number(response.error.code) : Number.NaN;
    return Number.isFinite(code) ? code : Number.NaN;
  }

  /**
   * @param {string} message
   * @param {...unknown} args
   * @returns {void}
   */
  #warn(message, ...args) {
    const logger = this.#logger;
    if (!logger || typeof logger.warn !== 'function') return;
    try {
      logger.warn(message, ...args);
    } catch {
      // Logging must never break the transport.
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Clear a named timer field.
   *
   * @param {'reconnect'|'coalesce'|'flash'} name
   * @returns {void}
   */
  #clearTimer(name) {
    if (name === 'reconnect' && this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
      return;
    }
    if (name === 'coalesce' && this.#coalesceTimer) {
      clearTimeout(this.#coalesceTimer);
      this.#coalesceTimer = null;
      return;
    }
    if (name === 'flash' && this.#flashTimer) {
      clearTimeout(this.#flashTimer);
      this.#flashTimer = null;
    }
  }

  /**
   * Cancel an active flash (used when `show()` or `stop()` supersedes it).
   *
   * @returns {void}
   */
  #clearFlash() {
    this.#clearTimer('flash');
    this.#flashActive = false;
    this.#flashBase = null;
  }
}
