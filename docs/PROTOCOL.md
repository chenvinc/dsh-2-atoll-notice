# Atoll third-party extension RPC protocol

What this plugin relies on, read out of the Atoll macOS app source; paths are
relative to the Atoll checkout (`DynamicIsland/...`); descriptors live in `AtollExtensionKit`.

## Transport

- `ws://127.0.0.1:9020` (`ExtensionRPCServer.swift:90`), one JSON-RPC 2.0 message
  per **text** frame over `NWProtocolWebSocket` (`autoReplyPing = true`,
  `ExtensionRPCServer.swift:104-108`).
- The listener binds loopback for both families (`.ipv4(.loopback)`,
  `.ipv6(.loopback)`, `ExtensionRPCServer.swift:84-88`) and re-checks every peer
  with `isLoopback` (`ExtensionRPCServer.swift:274`); it is not reachable from the
  LAN (`CHANGELOG.md:206`). A client identifies itself only by stating a bundle
  identifier: no secret, no TLS; the loopback binding is the only boundary.

## Requests, ids and binding

- `RPCRequest` is `{jsonrpc: String, method: String, params: RPCParams?, id: String}`
  (`DynamicIsland/services/Extensions/ExtensionRPCMessages.swift:27-33`).
  **`id` must be a JSON string**; anything else fails decoding and is answered with
  `-32700` and `id: null` (`ExtensionRPCServer.swift:376-384`). A request looks like
  `{"jsonrpc":"2.0","method":"atoll.requestAuthorization","params":{},"id":"dsh-1"}`.
- The first request whose `params` carry a `bundleIdentifier` binds the connection
  (`ExtensionRPCServer.swift:387-392`). Send `atoll.requestAuthorization` first: it
  binds the connection and authorizes the app in one step.
- Params are `{"bundleIdentifier": "...", "appName": "..."}`. `bundleIdentifier`
  falls back to the connection's; `appName` is accepted but ignored (the app name
  is recorded as the bundle identifier) (`ExtensionRPCService.swift:139-159`).
  Result: `{"authorized": true}`.
- Authorization is automatic: Atoll calls `authorizationManager.authorize` inline
  ("Auto-authorize for now (user can revoke in settings)"); there is no prompt to
  answer from our side. With third-party extensions disabled the call returns
  `-32002` "Extensions are disabled" (`ExtensionRPCService.swift:140-145`); the
  `enableThirdPartyExtensions` default is `true`
  (`DynamicIsland/models/Constants.swift:1381`).

## Methods used

| Method | Params | Result |
| --- | --- | --- |
| `atoll.requestAuthorization` | `{bundleIdentifier, appName?}` | `{"authorized":true}` |
| `atoll.presentLiveActivity` | `{descriptor}` | `{"success":true}` |
| `atoll.updateLiveActivity` | `{descriptor}` | `{"success":true}` |
| `atoll.dismissLiveActivity` | `{activityID, bundleIdentifier?}` | `{"success":true}` |

The full table (`ExtensionRPCService.swift:62-115`) also has `atoll.getVersion`, widget, notch and shelf methods.

## Descriptor envelope

Descriptors use a JSON-enum shape that Atoll rewrites before decoding
(`transformClientJSON`, `ExtensionRPCService.swift:618-729`):

- A field named `leadingIcon`, `trailingContent`, `progressIndicator`, `badgeIcon`,
  `leadingContent`, `icon` or `tint` shaped `{"type":"<case>", ...}` becomes
  `{"<case>": {...}}` (the `type` key is dropped). Objects with a `type` key inside
  `content` / `elements` arrays are rewritten the same way.
- Unnamed first Swift parameters move to `_0`: `text`/`marquee` `text` → `_0`,
  `icon` `icon` → `_0`, `progress` `indicator` → `_0`, `webView` `content` → `_0`.

So `{"leadingIcon":{"type":"symbol","name":"..."}}` reaches Atoll as
`{"leadingIcon":{"symbol":{...}}}`, and `{"type":"text","text":"2·1·3"}` as
`{"text":{"_0":"2·1·3"}}`. Validation
(`DynamicIsland/managers/Extensions/ExtensionDescriptorValidator.swift:22-41`)
requires `descriptor.isValid`, a valid `leadingIcon`, an optional valid `badgeIcon`
and `metadata.count <= 32`; failures map to `-32004`, decode failures to `-32603`
(`ExtensionRPCService.swift:339-354`).

## Present / update / dismiss

- `present` upserts: the same `id` for the same bundle identifier is replaced,
  otherwise appended
  (`DynamicIsland/managers/Extensions/ExtensionLiveActivityManager.swift:51-100`);
  it filters on `allowsMusicCoexistence` and sorts by `priority` then arrival
  (lines 152-169). The capacity limit (`extensionLiveActivityCapacity`) is only
  checked for a new id, so present is the safe recovery after `-32004`.
- `update` needs an existing activity or throws
  `invalidDescriptor("Missing existing activity")` → `-32004`
  (`ExtensionLiveActivityManager.swift:103-121`); update→present fallback is
  therefore correct and idempotent.
- `dismiss` removes the activity, is a **silent no-op when it is already gone**,
  and returns `{"success":true}` (`ExtensionLiveActivityManager.swift:123-138`);
  `activityID` is required (`-32602` when missing, `ExtensionRPCService.swift:216-225`).
- Atoll may push `atoll.activityDidDismiss` (`{bundleIdentifier, activityID}`, no `id`; `ExtensionRPCServer.swift:182-191`); ignore it and unknown ids.

## Error codes

`RPCErrorCode`, `ExtensionRPCMessages.swift:84-97`:

| Code | Meaning |
| --- | --- |
| `-32700` | parse error (frame is not a valid request) |
| `-32600` / `-32601` | invalid request / method not found |
| `-32602` | invalid params (missing `descriptor` or `activityID`) |
| `-32603` | internal error (e.g. descriptor decode failure) |
| `-32001` / `-32002` | unauthorized / feature disabled (third-party extensions off) |
| `-32003` | capacity exceeded |
| `-32004` / `-32005` | descriptor invalid / activity not found / unsupported content |

Responses echo the request `id`, and `result` is always a JSON object (`ExtensionRPCMessages.swift:32-49`).
