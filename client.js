/**
 * dsh-2-atoll-notice - browser half.
 *
 * One card on the Plugins settings page with the four switches the Host half
 * understands: mirror failed tasks, mirror tasks waiting for the human, mirror
 * finished tasks, and play the macOS alert sound. The card talks to the Host
 * over the same-origin JSON routes `lib/http.js` registers, so it needs no
 * services beyond `slots` and `locale` and no value import from any
 * `@deepseek-ai/*` package.
 *
 * There is no build step: elements are built with `React.createElement`, styles
 * are inline, and every failure path (no route, timeout, rejected save, late
 * response after unmount) degrades to a muted note instead of throwing into the
 * host page.
 */
window.__ModuleLoader__.load({
  id: "dsh-2-atoll-notice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /**
     * Tell the Host half how far this bundle got. A browser-side registration
     * failure is invisible from the terminal, so the card posts two tiny
     * same-origin beacons: the bundle ran, and the slot entry registered.
     * @param {string} stage
     * @param {unknown} [detail]
     */
    function beacon(stage, detail) {
      try {
        const body = JSON.stringify({
          stage,
          detail: detail === undefined ? null : String(detail && detail.stack ? detail.stack : detail),
          at: new Date().toISOString(),
        });
        void fetch("api/atoll-notice/client-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* a refused beacon must never break the card */
      }
    }
    beacon("bundle-loaded");
    /** Element constructor; keeps the tree readable without JSX. */
    const h = react.createElement;

    /** Locale namespace owned by this page. */
    const NS = "atollNotice";
    /** Entry id of the card inside the Plugins page's `plugins.item` slot. */
    const CARD_ID = "atoll-notice";
    /** After the official settings cards (20-50), before the task board (110). */
    const CARD_ORDER = 60;
    /** Same-origin route prefix; fetched without the leading slash. */
    const API_PATH = "api/atoll-notice";
    /** Hard cap on one request, so a hung Host cannot leave the card spinning. */
    const REQUEST_TIMEOUT_MS = 5000;
    /** Fields the card may change; everything else the Host answers is read-only. */
    const EDITABLE = ["failed", "attention", "done", "sound"];
    /** HTTP statuses that mean "this deployment does not mount the route". */
    const NOT_MOUNTED = new Set([404, 405, 501]);

    // ----------------------------------------------------------------- strings
    /** English copy, matching locale/en.json where a key exists there. */
    const en = {
      title: "Atoll Notices",
      description:
        "Choose which task states reach the Dynamic Island and whether a sound plays for each one.",
      states: "Task states",
      failed: "Show failed tasks",
      failedHint: "A red notice while a turn ends with an error.",
      attention: "Show tasks waiting for you",
      attentionHint: "A yellow notice while an approval or a question needs an answer.",
      done: "Show finished tasks",
      doneHint: "A green notice when a turn finishes without an error.",
      sound: "Play a sound",
      soundHint: "Uses a macOS system alert sound; at most one every few seconds.",
      connection: "Connection",
      portHint: "Atoll listens on this local port; change it only if Atoll was reconfigured.",
      connected: "Connected to Atoll.",
      disconnected: "Not connected to Atoll yet.",
      save: "Save",
      saving: "Saving",
      saved: "Saved",
      saveFailed: "The settings were not saved.",
      loading: "Reading the settings…",
      loadFailed: "The settings could not be read.",
      unavailable: "The Atoll Notices settings are not served by this deployment.",
      retry: "Retry",
    };
    /** Simplified Chinese copy, matching locale/zh.json where a key exists there. */
    const zh = {
      title: "Atoll 灵动岛通知",
      description: "选择哪些任务状态要显示在灵动岛，以及每种状态是否播放系统提示音。",
      states: "任务状态",
      failed: "显示失败任务",
      failedHint: "一轮对话以错误结束时亮红灯。",
      attention: "显示等待你处理的任务",
      attentionHint: "有工具调用待批准或有问题待回答时亮黄灯。",
      done: "显示已完成任务",
      doneHint: "一轮对话正常结束时亮绿灯。",
      sound: "播放提示音",
      soundHint: "使用 macOS 系统提示音，短时间内最多响一次。",
      connection: "连接",
      portHint: "Atoll 在本机该端口监听，仅当 Atoll 改过端口时才需要修改。",
      connected: "已连接 Atoll。",
      disconnected: "尚未连接 Atoll。",
      save: "保存",
      saving: "保存中",
      saved: "已保存",
      saveFailed: "设置未保存成功。",
      loading: "正在读取设置…",
      loadFailed: "读取设置失败。",
      unavailable: "当前部署没有提供 Atoll 灵动岛通知的设置项。",
      retry: "重试",
    };

    /**
     * Read a key without the locale service, used only if `props.t` is absent.
     * @param {string} key
     * @returns {string}
     */
    function fallbackTranslate(key) {
      let chinese = true;
      try {
        chinese = /^zh/i.test(String(globalThis.navigator?.language ?? "zh"));
      } catch {
        chinese = true;
      }
      const dict = chinese ? zh : en;
      return dict[key] ?? en[key] ?? key;
    }

    // -------------------------------------------------------------- host face
    /** Injected face: where the routes live and how long a request may take. */
    const FACE = Object.freeze({ apiPath: API_PATH, timeoutMs: REQUEST_TIMEOUT_MS });

    /**
     * The failure code a Host error body carries, shortened for display.
     * @param {unknown} body parsed response body
     * @returns {string}
     */
    function errorCode(body) {
      if (!body || typeof body !== "object") return "";
      const code = body.error;
      return typeof code === "string" ? code.slice(0, 64) : "";
    }

    /**
     * Coerce the Host's settings payload into the shape the card renders.
     * @param {unknown} raw
     * @returns {{ failed: boolean, attention: boolean, done: boolean, sound: boolean, soundName: string, port: number, bundleIdentifier: string } | undefined}
     */
    function normalizeSettings(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);
      const port = Number.isInteger(raw.port) ? raw.port : 0;
      return {
        failed: flag(raw.failed, true),
        attention: flag(raw.attention, true),
        done: flag(raw.done, true),
        sound: flag(raw.sound, false),
        soundName: typeof raw.soundName === "string" ? raw.soundName : "Glass",
        port: port > 0 && 65535 >= port ? port : 9020,
        bundleIdentifier: typeof raw.bundleIdentifier === "string" ? raw.bundleIdentifier : "",
      };
    }

    /**
     * One same-origin JSON request with a hard timeout. Never rejects.
     * @param {string} url relative path, no leading slash
     * @param {{ method?: string, body?: string }} options
     * @param {number} timeoutMs
     * @returns {Promise} on a transport failure `{ failed: "timeout" | "network" }`,
     *   otherwise `{ ok, status, body }` with `body` already parsed.
     */
    async function request(url, options, timeoutMs) {
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      let timer;
      if (controller) {
        timer = globalThis.setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs);
      }
      const headers =
        options.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" };
      let response;
      try {
        response = await fetch(url, {
          method: options.method || "GET",
          body: options.body,
          cache: "no-store",
          credentials: "same-origin",
          headers,
          signal: controller ? controller.signal : undefined,
        });
      } catch {
        const aborted = controller ? controller.signal.aborted : false;
        return { failed: aborted ? "timeout" : "network" };
      } finally {
        if (timer !== undefined) globalThis.clearTimeout(timer);
      }
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      let body;
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { ok: response.ok, status: response.status, body };
    }

    /**
     * GET the effective settings.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @returns {Promise} one of `{ kind: "ok", settings }`, `{ kind: "unavailable" }`
     *   or `{ kind: "error", code }`.
     */
    async function readSettings(face) {
      const result = await request(`${face.apiPath}/settings`, {}, face.timeoutMs);
      if (result.failed) return { kind: "error", code: result.failed };
      if (!result.ok) {
        const code = errorCode(result.body);
        if (NOT_MOUNTED.has(result.status)) return { kind: "unavailable" };
        return { kind: "error", code: code || `http-${result.status}` };
      }
      if (!result.body || typeof result.body !== "object") return { kind: "unavailable" };
      if (result.body.ok === false) return { kind: "error", code: errorCode(result.body) || "rejected" };
      const settings = normalizeSettings(result.body.settings);
      if (!settings) return { kind: "unavailable" };
      return { kind: "ok", settings };
    }

    /**
     * POST only the changed fields and adopt the Host's resolved answer.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @param {object} patch boolean fields to change
     * @returns {Promise} `{ kind: "ok", settings }` or `{ kind: "error", code }`.
     */
    async function writeSettings(face, patch) {
      const result = await request(
        `${face.apiPath}/settings`,
        { method: "POST", body: JSON.stringify({ settings: patch }) },
        face.timeoutMs,
      );
      if (result.failed) return { kind: "error", code: result.failed };
      const payload = result.body;
      if (!result.ok) {
        const code = errorCode(payload);
        return { kind: "error", code: code || `http-${result.status}` };
      }
      if (!payload || typeof payload !== "object" || payload.ok === false) {
        return { kind: "error", code: errorCode(payload) || "rejected" };
      }
      const settings = normalizeSettings(payload.settings);
      if (!settings) return { kind: "error", code: "invalid-response" };
      return { kind: "ok", settings };
    }

    /**
     * GET the mirror status. Optional: an older Host that omits the route only
     * costs the card its connection note.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @returns {Promise} `{ connected, authorized, lastError }`, or undefined.
     */
    async function readStatus(face) {
      const result = await request(`${face.apiPath}/status`, {}, face.timeoutMs);
      if (result.failed || !result.ok) return undefined;
      const status = result.body && typeof result.body === "object" ? result.body.status : undefined;
      if (!status || typeof status !== "object") return undefined;
      return {
        connected: status.connected === true,
        authorized: status.authorized === true,
        lastError:
          typeof status.lastError === "string" && status.lastError ? status.lastError.slice(0, 120) : "",
      };
    }

    // ------------------------------------------------------------------ styles
    const COLOR_PRIMARY = "var(--dsw-alias-label-primary, currentColor)";
    const COLOR_SECONDARY = "var(--dsw-alias-label-secondary, #4b5563)";
    const COLOR_TERTIARY = "var(--dsw-alias-label-tertiary, #6b7280)";
    const COLOR_ERROR = "var(--dsw-alias-label-error, #b42318)";
    const COLOR_SUCCESS = "var(--dsw-alias-state-success-primary, #1a7f37)";
    const COLOR_BRAND = "var(--dsw-alias-brand-primary, #4f6ef7)";
    const COLOR_BORDER = "var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.1))";
    const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const STYLE_ROOT = { display: "grid", gap: "14px", color: COLOR_PRIMARY, fontSize: "13px", lineHeight: 1.5 };
    const STYLE_DESCRIPTION = { margin: 0, color: COLOR_SECONDARY, fontSize: "13px" };
    const STYLE_SECTION = {
      margin: 0,
      color: COLOR_TERTIARY,
      fontSize: "11px",
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    };
    const STYLE_ROW = {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: "16px",
    };
    const STYLE_ROW_TEXT = { display: "grid", gap: "2px", minWidth: 0 };
    const STYLE_ROW_LABEL = { color: COLOR_PRIMARY, fontSize: "13px", cursor: "pointer" };
    const STYLE_HINT = { margin: 0, color: COLOR_TERTIARY, fontSize: "12px", lineHeight: 1.5 };
    const STYLE_CHECK = { width: "16px", height: "16px", margin: "2px 0 0", accentColor: COLOR_BRAND, cursor: "pointer", flex: "none" };
    const STYLE_CONNECTION = {
      display: "grid",
      gap: "2px",
      paddingTop: "12px",
      borderTop: `1px solid ${COLOR_BORDER}`,
    };
    const STYLE_TARGET = { fontFamily: FONT_MONO, fontSize: "12px", color: COLOR_PRIMARY, overflowWrap: "anywhere" };
    const STYLE_FOOTER = {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      paddingTop: "12px",
      borderTop: `1px solid ${COLOR_BORDER}`,
    };
    const STYLE_BUTTON = {
      font: "inherit",
      fontSize: "13px",
      padding: "5px 14px",
      borderRadius: "6px",
      border: "none",
      color: "var(--dsw-alias-label-primary-foreground, #ffffff)",
      background: COLOR_BRAND,
      cursor: "pointer",
    };
    const STYLE_BUTTON_OFF = { ...STYLE_BUTTON, opacity: 0.5, cursor: "default" };
    const STYLE_LINK_BUTTON = {
      font: "inherit",
      fontSize: "13px",
      padding: 0,
      border: "none",
      background: "none",
      color: "var(--dsw-alias-link, #2563eb)",
      cursor: "pointer",
      textDecoration: "underline",
    };
    const STYLE_NOTE = { margin: 0, color: COLOR_TERTIARY, fontSize: "12px" };

    // -------------------------------------------------------------- components
    /**
     * One labelled switch with its own hint line.
     * @param {object} spec
     * @param {(key: string) => string} spec.t locale reader
     * @param {string} spec.field settings field the switch edits
     * @param {string} spec.hintKey dictionary key of the hint line
     * @param {boolean} spec.checked
     * @param {boolean} spec.disabled
     * @param {(value: boolean) => void} spec.onChange
     * @returns {object} the row element
     */
    function renderRow(spec) {
      const inputId = `atoll-notice-${spec.field}`;
      return h(
        "div",
        { style: STYLE_ROW, key: spec.field },
        h(
          "div",
          { style: STYLE_ROW_TEXT },
          h("label", { htmlFor: inputId, style: STYLE_ROW_LABEL }, spec.t(spec.field)),
          h("p", { style: STYLE_HINT }, spec.t(spec.hintKey)),
        ),
        h("input", {
          id: inputId,
          type: "checkbox",
          checked: spec.checked,
          disabled: spec.disabled,
          style: STYLE_CHECK,
          onChange: (event) => spec.onChange(Boolean(event.target.checked)),
        }),
      );
    }

    /**
     * The card body: four switches, the RPC target, and one save control.
     *
     * Props come from the slot composition: `view` and `t` from the slot
     * runtime and the locale option, `atollNotice` from `inject()`.
     * @param {object} props
     * @param {"summary" | "page"} [props.view]
     * @param {(key: string) => string} [props.t]
     * @param {{ apiPath: string, timeoutMs: number }} [props.atollNotice]
     * @returns {string | object} the one-liner, or the page body
     */
    function AtollNoticeCard(props) {
      const t = typeof props.t === "function" ? props.t : fallbackTranslate;
      const injected = props.atollNotice && typeof props.atollNotice === "object" ? props.atollNotice : FACE;
      const face = {
        apiPath: typeof injected.apiPath === "string" && injected.apiPath ? injected.apiPath : API_PATH,
        timeoutMs:
          Number.isFinite(injected.timeoutMs) && injected.timeoutMs > 0
            ? injected.timeoutMs
            : REQUEST_TIMEOUT_MS,
      };

      const alive = react.useRef(true);
      const [phase, setPhase] = react.useState("loading");
      const [saved, setSaved] = react.useState(null);
      const [staged, setStaged] = react.useState(null);
      const [saving, setSaving] = react.useState(false);
      const [saveCode, setSaveCode] = react.useState("");
      const [justSaved, setJustSaved] = react.useState(false);
      const [connection, setConnection] = react.useState(undefined);
      const [loadCode, setLoadCode] = react.useState("");

      /** Read the card's two routes; late answers after unmount are dropped. */
      const load = async () => {
        setPhase("loading");
        setLoadCode("");
        const [settings, status] = await Promise.all([
          readSettings(face).catch(() => ({ kind: "error", code: "network" })),
          readStatus(face).catch(() => undefined),
        ]);
        if (!alive.current) return;
        setConnection(status);
        if (settings.kind === "ok") {
          setSaved(settings.settings);
          setStaged(settings.settings);
          setPhase("ready");
          return;
        }
        if (settings.kind === "unavailable") {
          setPhase("unavailable");
          return;
        }
        setLoadCode(settings.code || "request-failed");
        setPhase("error");
      };

      react.useEffect(() => {
        alive.current = true;
        void load();
        return () => {
          alive.current = false;
        };
        // The card loads once per mount; a retry calls load() directly.
      }, []);

      react.useEffect(() => {
        if (!justSaved) return undefined;
        const timer = globalThis.setTimeout(() => {
          if (alive.current) setJustSaved(false);
        }, 2500);
        return () => globalThis.clearTimeout(timer);
      }, [justSaved]);

      if (props.view === "summary") return t("description");

      /** Stage one switch; nothing reaches the Host until the user saves. */
      const edit = (field, value) => {
        setJustSaved(false);
        setSaveCode("");
        setStaged((current) => (current ? { ...current, [field]: value } : current));
      };

      const changed =
        staged && saved ? EDITABLE.filter((field) => staged[field] !== saved[field]) : [];
      const dirty = changed.length > 0;

      /** Send only the changed fields, then adopt the Host's resolved answer. */
      const save = async () => {
        if (!dirty || saving) return;
        const patch = {};
        for (const field of changed) patch[field] = staged[field];
        setSaving(true);
        setSaveCode("");
        const result = await writeSettings(face, patch).catch(() => ({
          kind: "error",
          code: "network",
        }));
        if (!alive.current) return;
        setSaving(false);
        if (result.kind === "ok") {
          setSaved(result.settings);
          setStaged(result.settings);
          setJustSaved(true);
          return;
        }
        setSaveCode(result.code || "request-failed");
      };

      const body = [];

      if (phase === "loading") {
        body.push(h("p", { style: STYLE_NOTE, key: "loading" }, t("loading")));
      } else if (phase === "unavailable") {
        body.push(h("p", { style: STYLE_NOTE, key: "unavailable" }, t("unavailable")));
      } else if (phase === "error") {
        body.push(
          h(
            "p",
            { style: STYLE_NOTE, key: "load-error" },
            `${t("loadFailed")} (${loadCode}) `,
            h("button", { type: "button", style: STYLE_LINK_BUTTON, onClick: () => void load() }, t("retry")),
          ),
        );
      } else if (staged) {
        const disabled = saving;
        body.push(
          h(
            "div",
            { style: { display: "grid", gap: "10px" }, key: "rows" },
            h("p", { style: STYLE_SECTION }, t("states")),
            renderRow({ t, field: "failed", hintKey: "failedHint", checked: staged.failed, disabled, onChange: (value) => edit("failed", value) }),
            renderRow({ t, field: "attention", hintKey: "attentionHint", checked: staged.attention, disabled, onChange: (value) => edit("attention", value) }),
            renderRow({ t, field: "done", hintKey: "doneHint", checked: staged.done, disabled, onChange: (value) => edit("done", value) }),
            renderRow({ t, field: "sound", hintKey: "soundHint", checked: staged.sound, disabled, onChange: (value) => edit("sound", value) }),
          ),
        );

        const connectionNote = connection
          ? connection.connected
            ? h("p", { style: { ...STYLE_HINT, color: COLOR_SUCCESS } }, t("connected"))
            : h(
                "p",
                { style: STYLE_HINT },
                `${t("disconnected")}${connection.lastError ? ` ${connection.lastError}` : ""}`,
              )
          : null;
        body.push(
          h(
            "div",
            { style: STYLE_CONNECTION, key: "connection" },
            h("p", { style: STYLE_SECTION }, t("connection")),
            h("code", { style: STYLE_TARGET }, `ws://127.0.0.1:${staged.port}`),
            h("p", { style: STYLE_HINT }, t("portHint")),
            connectionNote,
          ),
        );

        const statusText = saving
          ? t("saving")
          : saveCode
            ? `${t("saveFailed")} (${saveCode})`
            : justSaved
              ? t("saved")
              : "";
        const statusColor = saving ? COLOR_TERTIARY : saveCode ? COLOR_ERROR : COLOR_SUCCESS;

        body.push(
          h(
            "div",
            { style: STYLE_FOOTER, key: "footer" },
            h(
              "button",
              {
                type: "button",
                style: dirty && !saving ? STYLE_BUTTON : STYLE_BUTTON_OFF,
                disabled: !dirty || saving,
                onClick: () => void save(),
              },
              saving ? t("saving") : t("save"),
            ),
            statusText
              ? h("span", { role: "status", style: { ...STYLE_HINT, color: statusColor } }, statusText)
              : null,
          ),
        );
      }

      return h(
        "div",
        { style: STYLE_ROOT, "data-atoll-notice": CARD_ID },
        h("p", { style: STYLE_DESCRIPTION, key: "description" }, t("description")),
        ...body,
      );
    }

    // ------------------------------------------------------------------- mount
    /**
     * Log a refused registration instead of leaving the page blank.
     * @param {string} where
     * @param {unknown} error
     */
    function warn(where, error) {
      try {
        console.warn(`[dsh-2-atoll-notice] ${where} failed`, error);
      } catch {
        /* ignore */
      }
    }

    /** Required services (cordis fiber inject). */
    const inject = ["slots", "locale"];

    /**
     * Mount the browser half.
     * @param {import('@deepseek-ai/cordis').Context} ctx browser plugin context
     */
    function apply(ctx) {
      try {
        beacon("apply-enter");
        const t = ctx.locale.bind(NS);
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), "atoll-notice: dictionaries");
        } catch (error) {
          warn("dictionary registration", error);
        }
        try {
          ctx.effect(
            () =>
              ctx.slots.inject("plugins.item", () =>
                ctx.slots.register(
                  {
                    name: "plugins.item",
                    id: CARD_ID,
                    order: CARD_ORDER,
                    label: () => t("title"),
                    locale: NS,
                    inject: () => ({ atollNotice: FACE }),
                  },
                  AtollNoticeCard,
                ),
              ),
            "atoll-notice: plugins card",
          );
          beacon("card-registered");
        } catch (error) {
          beacon("card-registration-failed", error);
          warn("card registration", error);
        }
      } catch (error) {
        beacon("apply-failed", error);
        warn("apply", error);
      }
    }

    exports.NS = NS;
    exports.AtollNoticeCard = AtollNoticeCard;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
