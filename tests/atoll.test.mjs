/**
 * Behaviour tests for the Atoll transport (`lib/atoll.js`).
 *
 * A scripted fake WebSocket stands in for the Atoll macOS app: it records every
 * request the client sends and replies through a plain object of per-method
 * handlers. Timers are real but short (5-40 ms), so the suite stays fast while
 * still exercising coalescing, timeouts, reconnects and flash restoration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AtollClient } from '../lib/atoll.js';

const BUNDLE = 'com.deepseek.dsh.atoll-notice.test';
const ACTIVITY_ID = 'dsh-status';

/**
 * @param {string} title
 * @param {Record<string, unknown>} [extra]
 * @returns {object} Descriptor shaped like the one `lib/format.js` builds.
 */
function descriptor(title, extra = {}) {
  return {
    id: ACTIVITY_ID,
    bundleIdentifier: BUNDLE,
    priority: 'high',
    title,
    subtitle: '1 失败 · 0 待确认 · 2 完成',
    leadingIcon: { type: 'symbol', name: 'exclamationmark.triangle.fill', size: 15 },
    trailingContent: { type: 'text', text: '1·0·2' },
    accentColor: { red: 1, green: 0.23, blue: 0.19, alpha: 1 },
    allowsMusicCoexistence: true,
    metadata: { counts: '1,0,2' },
    ...extra,
  };
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `predicate` is truthy; resolves with its value.
 *
 * @param {() => unknown} predicate
 * @param {{timeout?: number, interval?: number}} [options]
 * @returns {Promise<any>}
 */
async function until(predicate, { timeout = 500, interval = 2 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeout}ms`);
    await wait(interval);
  }
}

/**
 * Build a fake WebSocket server.
 *
 * `overrides` maps an RPC method to a handler. A handler receives the request
 * frame and returns either:
 *   - `undefined` -> fall through to the default reply,
 *   - `false`     -> swallow the request (simulates a timeout),
 *   - `{result}`  -> successful reply,
 *   - `{error}`   -> error reply.
 * The object is mutable so a test can change behaviour mid-flight.
 *
 * @param {Record<string, any>} [overrides]
 */
function createHarness(overrides = {}) {
  /** @type {any[]} */
  const sockets = [];
  /** @type {any[]} */
  const calls = [];

  class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      sockets.push(this);
    }

    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }

    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter((entry) => entry !== handler));
    }

    /** @param {string} type @param {any} event */
    emit(type, event = {}) {
      for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }

    /** @param {string} raw */
    send(raw) {
      const frame = JSON.parse(raw);
      calls.push(frame);
      respond(this, frame);
    }

    /**
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', { code, reason }));
    }

    // --- test helpers -----------------------------------------------------
    open() {
      this.readyState = 1;
      this.emit('open', {});
    }

    /** @param {number} [code] */
    drop(code = 1006) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', { code });
    }

    /** @param {any} payload */
    receive(payload) {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      queueMicrotask(() => this.emit('message', { data }));
    }
  }

  /** @param {FakeWebSocket} socket @param {any} frame */
  function respond(socket, frame) {
    const handler = overrides[frame.method];
    if (handler === false) return;
    if (typeof handler === 'function') {
      const reply = handler(frame, socket);
      if (reply === undefined) return defaultReply(socket, frame);
      if (reply === false) return;
      socket.receive({ jsonrpc: '2.0', id: frame.id, ...reply });
      return;
    }
    defaultReply(socket, frame);
  }

  /** @param {FakeWebSocket} socket @param {any} frame */
  function defaultReply(socket, frame) {
    const result =
      frame.method === 'atoll.requestAuthorization'
        ? { authorized: true }
        : { success: true };
    socket.receive({ jsonrpc: '2.0', id: frame.id, result });
  }

  return {
    overrides,
    sockets,
    calls,
    factory: (url) => new FakeWebSocket(url),
    latest: () => sockets[sockets.length - 1],
    methods: () => calls.map((call) => call.method),
    callsOf: (method) => calls.filter((call) => call.method === method),
  };
}

/**
 * @param {ReturnType<typeof createHarness>} harness
 * @param {Record<string, unknown>} [overrides]
 * @returns {AtollClient}
 */
function createClient(harness, overrides = {}) {
  return new AtollClient({
    bundleIdentifier: BUNDLE,
    webSocket: harness.factory,
    coalesceMs: 5,
    requestTimeoutMs: 40,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    ...overrides,
  });
}

/**
 * Start a client and complete the authorization handshake.
 *
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof createHarness>} harness
 * @param {Record<string, unknown>} [overrides]
 */
async function startedClient(t, harness, overrides = {}) {
  const client = createClient(harness, overrides);
  t.after(() => client.stop());
  client.start();
  harness.latest().open();
  await until(() => client.state().authorized === true);
  return client;
}

// ---------------------------------------------------------------------------
// Handshake, present, update
// ---------------------------------------------------------------------------

test('authorizes first, then presents the desired descriptor', async (t) => {
  const harness = createHarness();
  const client = createClient(harness);
  t.after(() => client.stop());

  client.start();
  assert.equal(harness.sockets.length, 1);
  const socket = harness.latest();
  const url = socket.url;
  assert.equal(url, 'ws://127.0.0.1:9020');

  socket.open();
  await until(() => harness.callsOf('atoll.requestAuthorization').length === 1);
  const auth = harness.callsOf('atoll.requestAuthorization')[0];
  assert.equal(auth.jsonrpc, '2.0');
  assert.equal(typeof auth.id, 'string');
  assert.equal(auth.method, 'atoll.requestAuthorization');
  assert.deepEqual(auth.params, { appName: BUNDLE, bundleIdentifier: BUNDLE });
  await until(() => client.state().authorized === true);

  client.show(descriptor('任务 1'));
  const present = await until(() => harness.callsOf('atoll.presentLiveActivity')[0]);
  assert.equal(present.params.descriptor.title, '任务 1');
  assert.equal(present.params.descriptor.id, ACTIVITY_ID);
  assert.deepEqual(present.params.descriptor.leadingIcon, descriptor('x').leadingIcon);
  await until(() => client.state().activityId === ACTIVITY_ID);
  assert.equal(typeof client.state().presentedAt, 'number');
  assert.equal(client.state().lastError, null);
  assert.equal(harness.methods()[0], 'atoll.requestAuthorization');
});

test('updates an activity that is already presented', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  client.show(descriptor('任务 2'));
  const update = await until(() => harness.callsOf('atoll.updateLiveActivity')[0]);
  assert.equal(update.params.descriptor.title, '任务 2');
  await wait(20);
  assert.equal(harness.callsOf('atoll.presentLiveActivity').length, 1);
  assert.equal(client.state().activityId, ACTIVITY_ID);
  assert.equal(client.state().lastError, null);
});

test('falls back from update to present on -32004', async (t) => {
  const harness = createHarness({
    'atoll.updateLiveActivity': () => ({
      error: { code: -32004, message: 'Missing existing activity' },
    }),
  });
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  client.show(descriptor('任务 2'));
  const present = await until(() => harness.callsOf('atoll.presentLiveActivity')[1]);
  assert.equal(present.params.descriptor.title, '任务 2');
  assert.deepEqual(harness.methods().slice(1), [
    'atoll.presentLiveActivity',
    'atoll.updateLiveActivity',
    'atoll.presentLiveActivity',
  ]);
  await until(() => client.state().activityId === ACTIVITY_ID);
  assert.equal(client.state().lastError, null);
});

test('also falls back from update to present on -32001', async (t) => {
  const harness = createHarness({
    'atoll.updateLiveActivity': () => ({
      error: { code: -32001, message: 'Unauthorized' },
    }),
  });
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  client.show(descriptor('任务 2'));
  const present = await until(() => harness.callsOf('atoll.presentLiveActivity')[1]);
  assert.equal(present.params.descriptor.title, '任务 2');
  await until(() => client.state().activityId === ACTIVITY_ID);
  assert.equal(client.state().lastError, null);
});

test('dismisses on show(null) and does not re-dismiss nothing', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  client.show(null);
  const dismiss = await until(() => harness.callsOf('atoll.dismissLiveActivity')[0]);
  assert.deepEqual(dismiss.params, { activityID: ACTIVITY_ID, bundleIdentifier: BUNDLE });
  await until(() => client.state().activityId === null);
  assert.equal(client.state().presentedAt, null);

  const before = harness.calls.length;
  client.show(null);
  await wait(25);
  assert.equal(harness.calls.length, before);
  assert.equal(harness.callsOf('atoll.dismissLiveActivity').length, 1);
});

// ---------------------------------------------------------------------------
// Reconnect, malformed frames, timeouts
// ---------------------------------------------------------------------------

test('reconnects after an unexpected close and re-presents', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  const first = descriptor('任务 1');
  client.show(first);
  await until(() => harness.callsOf('atoll.presentLiveActivity').length === 1);

  harness.latest().drop(1006);
  await until(() => harness.sockets.length === 2);
  assert.equal(client.state().connected, false);
  assert.equal(client.state().authorized, false);

  harness.latest().open();
  await until(() => harness.callsOf('atoll.requestAuthorization').length === 2);
  const present = await until(() => harness.callsOf('atoll.presentLiveActivity')[1]);
  assert.equal(present.params.descriptor.title, '任务 1');
  assert.deepEqual(present.params.descriptor, first);
  await until(() => client.state().activityId === ACTIVITY_ID);
  assert.equal(client.state().connected, true);
  assert.equal(client.state().authorized, true);
});

test('ignores malformed and unsolicited frames', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);
  const socket = harness.latest();

  socket.receive('this is not json');
  socket.receive([1, 2, 3]);
  socket.receive({ jsonrpc: '2.0', method: 'atoll.activityDidDismiss', params: {} });
  socket.receive({ jsonrpc: '2.0', id: 'dsh-999999', result: { success: true } });
  await wait(10);

  assert.equal(client.state().lastError, null);
  assert.equal(client.state().connected, true);
  assert.equal(client.state().authorized, true);

  // The client is still fully usable afterwards.
  client.show(descriptor('任务 2'));
  const update = await until(() => harness.callsOf('atoll.updateLiveActivity')[0]);
  assert.equal(update.params.descriptor.title, '任务 2');
});

test('reports a request timeout in state().lastError without throwing', async (t) => {
  const harness = createHarness({ 'atoll.presentLiveActivity': false });
  const client = await startedClient(t, harness, { requestTimeoutMs: 20 });

  assert.doesNotThrow(() => client.show(descriptor('任务 1')));
  const error = await until(() => client.state().lastError, { timeout: 300 });
  assert.match(error, /timed out/);
  assert.equal(client.state().activityId, null);
  assert.equal(harness.callsOf('atoll.presentLiveActivity').length, 1);

  // A later successful present clears the error and updates the state.
  harness.overrides['atoll.presentLiveActivity'] = () => ({ result: { success: true } });
  client.show(descriptor('任务 2'));
  await until(() => client.state().activityId === ACTIVITY_ID);
  assert.equal(client.state().lastError, null);
  assert.equal(harness.callsOf('atoll.presentLiveActivity').length, 2);
});

// ---------------------------------------------------------------------------
// Flash, stop, status subscription
// ---------------------------------------------------------------------------

test('flash shows temporarily and restores the last shown descriptor', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  client.show(descriptor('基线'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  client.flash(descriptor('临时 1'), 30);
  const flashed = await until(() => harness.callsOf('atoll.updateLiveActivity')[0]);
  assert.equal(flashed.params.descriptor.title, '临时 1');

  await until(() => {
    const updates = harness.callsOf('atoll.updateLiveActivity');
    return updates.length >= 2 && updates[updates.length - 1].params.descriptor.title === '基线';
  });
  assert.equal(client.state().activityId, ACTIVITY_ID);

  // A second flash replaces the first and still restores the base descriptor.
  client.flash(descriptor('临时 A'), 40);
  client.flash(descriptor('临时 B'), 40);
  await until(() => {
    const updates = harness.callsOf('atoll.updateLiveActivity');
    return updates[updates.length - 1].params.descriptor.title === '临时 B';
  });
  await until(() => {
    const updates = harness.callsOf('atoll.updateLiveActivity');
    return updates[updates.length - 1].params.descriptor.title === '基线';
  });
});

test('stop prevents further reconnects and is idempotent', async (t) => {
  const harness = createHarness();
  const client = await startedClient(t, harness);

  client.show(descriptor('任务 1'));
  await until(() => client.state().activityId === ACTIVITY_ID);

  await client.stop();
  assert.equal(client.state().connected, false);
  assert.equal(client.state().authorized, false);
  assert.equal(client.state().activityId, null);
  assert.equal(client.state().presentedAt, null);

  await wait(40);
  assert.equal(harness.sockets.length, 1);
  await assert.doesNotReject(() => client.stop());
});

test('onStateChange fires on real changes and unsubscribes', async (t) => {
  const harness = createHarness();
  const client = createClient(harness);
  t.after(() => client.stop());

  const seen = [];
  const off = client.onStateChange((state) => seen.push(state));
  client.start();
  harness.latest().open();
  await until(() => client.state().authorized === true);
  assert.ok(seen.some((state) => state.connected === true));
  assert.ok(seen.some((state) => state.authorized === true));
  for (const state of seen) assert.equal(typeof state, 'object');

  const count = seen.length;
  off();
  harness.latest().drop(1006);
  await wait(25);
  assert.equal(seen.length, count);
});

test('a listener that throws cannot break delivery to the others', async (t) => {
  const harness = createHarness();
  const client = createClient(harness);
  t.after(() => client.stop());

  const seen = [];
  client.onStateChange(() => {
    throw new Error('listener exploded');
  });
  client.onStateChange((state) => seen.push(state));
  client.start();
  harness.latest().open();
  await until(() => client.state().authorized === true);
  assert.ok(seen.length > 0);
});

test('without a bundleIdentifier, start() reports through lastError', async (t) => {
  const harness = createHarness();
  const client = new AtollClient({ webSocket: harness.factory, coalesceMs: 5 });
  t.after(() => client.stop());

  assert.doesNotThrow(() => client.start());
  assert.doesNotThrow(() => client.show(descriptor('任务 1')));
  assert.match(client.state().lastError, /bundleIdentifier/);
  await wait(10);
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.calls.length, 0);
});

test('dismisses activities a crashed run left behind, before presenting', async () => {
  const harness = createHarness();
  const client = createClient(harness, { staleActivityIds: [ACTIVITY_ID] });
  client.start();
  harness.latest().open();

  await until(() => harness.callsOf('atoll.dismissLiveActivity').length > 0);
  await until(() => harness.callsOf('atoll.requestAuthorization').length > 0);

  const dismissals = harness.callsOf('atoll.dismissLiveActivity');
  assert.equal(dismissals.length, 1, 'exactly one sweep per handshake');
  assert.deepEqual(dismissals[0].params, {
    activityID: ACTIVITY_ID,
    bundleIdentifier: BUNDLE,
  });
  assert.ok(
    harness.methods().indexOf('atoll.dismissLiveActivity') <
      harness.methods().indexOf('atoll.presentLiveActivity') ||
      !harness.methods().includes('atoll.presentLiveActivity'),
    'the sweep runs before anything of ours is presented',
  );
  client.stop();
});

test('leaves foreign activities alone when no stale ids are configured', async () => {
  const harness = createHarness();
  const client = createClient(harness);
  client.start();
  harness.latest().open();
  await until(() => harness.callsOf('atoll.requestAuthorization').length > 0);
  await wait(20);
  assert.equal(harness.callsOf('atoll.dismissLiveActivity').length, 0);
  client.stop();
});
