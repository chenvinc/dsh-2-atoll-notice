# Settings card (browser half)

`client.js` is the browser half: one card on the Plugins settings page with the four
toggles the Host half honours — mirror failed, waiting-for-you and finished tasks,
and the alert sound. No build step, no CSS file, no runtime npm dependency.

## Module wrapper and slot contract

The entry is a classic client script, not an imported ES module: it calls
`window.__ModuleLoader__.load({ id, factory })`, and `factory(require)` returns
`module.exports` carrying `apply` and `inject`. Only `react` is required, with
`React.createElement` for elements; there is no `react/jsx-runtime`, `react-dom`,
CSS, or `@deepseek-ai/*` value import. References followed, not copied:
- `/Users/chy/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-settings-web-search/lib/client.js` — first-party card: `ctx.locale.register(NS, { zh, en })`, then `plugins.item` with `id`, `order`, `label`, `locale`, `inject`.
- `/Users/chy/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/client.js` — third-party plugin: same wrapper, `ctx.effect(fn, label)`, Host routes fetched relatively (`fetch("api/task-board/...")`).
- `@deepseek-ai/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts` — `plugins.item` owner props, `{ view: "summary" | "page", form? }`.

Registered from `apply(ctx)` (`inject = ["slots", "locale"]`):

```js
ctx.effect(() => ctx.locale.register("atollNotice", { zh, en }), "atoll-notice: dictionaries")
ctx.effect(() => ctx.slots.inject("plugins.item", () => ctx.slots.register({
  name: "plugins.item", id: "atoll-notice", order: 60,
  label: () => t("title"), locale: "atollNotice",
  inject: () => ({ atollNotice: FACE }),
}, AtollNoticeCard)), "atoll-notice: plugins card")
```

`summary` is the one-liner; `page` is the body inside the plugin's page, which
already draws the title from `label` and the description from `summary` — the card
body starts with its description line and section labels, not a title.

## HTTP contract consumed

Same origin, no leading slash, `credentials: "same-origin"`, `AbortController`
timeout of 5 s, `cache: "no-store"`.

- `GET api/atoll-notice/settings` → `{ ok: true, settings: { failed, attention,
  done, sound, soundName, port, bundleIdentifier } }`.
- `POST api/atoll-notice/settings` with `{ settings: { <changed fields only> } }`
  → `{ ok: true, settings: <full resolved> }`; the card adopts that answer.
- `GET api/atoll-notice/status` — optional; `connected` / `lastError` feed the
  connection note and the route is ignored when absent.
- Failure is any non-2xx `{ ok: false, error: "short-code" }`. `404/405/501`, a
  non-JSON body (SPA shell), or a missing `settings` object mean "not served
  here" and render a muted note, never an error.

## Props

`props.view` (`"summary" | "page"`); `props.t` (locale reader bound to
`atollNotice`, with a local zh/en dictionary fallback); `props.atollNotice` from
`inject()`: `{ apiPath, timeoutMs }` — `"api/atoll-notice"`, `5000`.

## Verification

`node --check client.js` passes; no top-level `import`, no JSX tag, no `<` at all.
A scratch harness (tiny hook runtime, mocked `fetch`, outside the repository) drove
the real component: loading → ready, toggle → dirty, a save posting only
`{"settings":{"attention":false}}`, the adopted Host answer, a failed save keeping
the staged edit, 404 and HTML-fallback unavailability, the connection note, and a
late response after unmount.

## Not verifiable from this machine

No browser automation is available here, so rendered pixels, the order 60 position
and live locale switching were not observed. To check by hand: open
`http://127.0.0.1:3080`, go to **Plugins**, find **Atoll 灵动岛通知**, open it,
toggle a switch, press 保存, reload, confirm it persisted. Without the Host routes
the card shows the muted "not served here" note and the page keeps working.
