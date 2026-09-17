import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview, getAllWebviews } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

// ── types ──────────────────────────────────────────────────────────────
interface PageInfo {
  url: string;
  final_url: string;
  status: number;
  headers: [string, string][];
  title: string | null;
  content_type: string | null;
  content_length: number | null;
  server: string | null;
}

interface Props {
  visible: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────
function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "about:blank";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+/.test(t) && !t.includes(" ")) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function statusColor(code: number): string {
  if (code < 300) return "#3fae7a";
  if (code < 400) return "#f0a500";
  if (code < 500) return "#ff7043";
  return "#ef5350";
}

// Module-level webview ref — persists across re-renders
let _wv: Webview | null = null;
let _wvCounter = 0;

// ── component ──────────────────────────────────────────────────────────
// Uses Tauri's JS-level child Webview API (setPosition/setSize/show/hide).
// This is known-broken on Linux/GTK (child webviews live in a plain gtk::Box
// with no absolute-positioning support, plus an unrelated GTK-only crash in
// tauri-runtime-wry's resize hit-testing when any extra widget is present in
// the window tree — see native_browser.rs for the Linux-specific
// raw-GTK workaround). On macOS, child webviews are NSViews positioned by
// real frame coordinates, so neither issue applies and this should work
// as expected out of the box.
export default function BrowserPage({ visible }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [urlInput, setUrlInput] = useState("https://www.google.com");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [wvReady, setWvReady] = useState(false);
  const [wvError, setWvError] = useState<string | null>(null);

  // Inspect overlay — hides the webview while open, avoiding any need to
  // share space with it inline.
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectTab, setInspectTab] = useState<"headers" | "info" | "cookies">("headers");
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  // ── webview helpers ────────────────────────────────────────────────
  const getViewportRect = useCallback(() => {
    if (!viewportRef.current) return null;
    const rect = viewportRef.current.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    return rect;
  }, []);

  const syncWebviewBounds = useCallback((attempt = 0) => {
    if (!_wv) return;
    const rect = getViewportRect();
    if (!rect) return;
    const wvSnap = _wv;
    const size = new LogicalSize(Math.round(rect.width), Math.round(rect.height));
    const pos = new LogicalPosition(Math.round(rect.x), Math.round(rect.y));
    Promise.all([wvSnap.setSize(size), wvSnap.setPosition(pos)]).catch(() => {
      if (attempt < 20 && wvSnap === _wv) {
        setTimeout(() => syncWebviewBounds(attempt + 1), 100);
      }
    });
  }, [getViewportRect]);

  const destroyWebview = useCallback(async () => {
    if (_wv) {
      try { await _wv.close(); } catch { /* already gone */ }
      _wv = null;
      setWvReady(false);
    }
  }, []);

  const createWebview = useCallback(async (url: string) => {
    const rect = getViewportRect();
    if (!rect) return;

    await destroyWebview();

    _wvCounter += 1;
    const label = `browser_${_wvCounter}`;

    try {
      const win = getCurrentWindow();
      _wv = new Webview(win, label, {
        url,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      setWvReady(true);
      setWvError(null);
      setCurrentUrl(url);
      setUrlInput(url);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => syncWebviewBounds());
      });
    } catch (e) {
      setWvError(`Failed to embed browser: ${String(e)}`);
    }
  }, [getViewportRect, destroyWebview, syncWebviewBounds]);

  const navigate = useCallback(async (rawUrl: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url || url === "about:blank") return;
    setLoading(true);
    setWvError(null);
    try {
      await createWebview(url);
    } catch (e) {
      setWvError(`Navigation error: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [createWebview]);

  // ── lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    getAllWebviews()
      .then((all) => {
        for (const wv of all) {
          if (wv.label.startsWith("browser_") && wv.label !== _wv?.label) {
            wv.close().catch(() => { });
          }
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (!visible || _wv) return;
    createWebview("https://www.google.com");
  }, [visible, createWebview]);

  useEffect(() => {
    if (!_wv) return;
    if (!visible || inspectOpen) {
      const hideWithRetry = (attempt = 0) => {
        if (!_wv) return;
        _wv.hide().catch(() => {
          if (attempt < 20) setTimeout(() => hideWithRetry(attempt + 1), 100);
        });
      };
      hideWithRetry();
      return;
    }
    const wvSnap = _wv;
    let cancelled = false;
    const tryShow = async (attempt: number) => {
      if (cancelled || wvSnap !== _wv) return;
      try {
        await wvSnap.show();
        if (!cancelled) syncWebviewBounds();
      } catch {
        if (attempt < 20 && !cancelled) setTimeout(() => tryShow(attempt + 1), 100);
      }
    };
    tryShow(0);
    return () => { cancelled = true; };
  }, [visible, inspectOpen, syncWebviewBounds, wvReady]);

  useEffect(() => {
    if (!viewportRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (visible && !inspectOpen) syncWebviewBounds();
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [visible, inspectOpen, syncWebviewBounds]);

  useEffect(() => {
    const onResize = () => { if (visible && !inspectOpen) syncWebviewBounds(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [visible, inspectOpen, syncWebviewBounds]);

  useEffect(() => {
    return () => { destroyWebview(); };
  }, [destroyWebview]);

  // ── handlers ───────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(urlInput);
  }

  function handleRefresh() {
    if (currentUrl) navigate(currentUrl);
  }

  async function handleInspectToggle() {
    const opening = !inspectOpen;
    setInspectOpen(opening);
    if (opening) {
      const url = currentUrl || urlInput.trim();
      if (!url) return;
      setInfoLoading(true);
      setInfoError(null);
      setPageInfo(null);
      try {
        const info = await invoke<PageInfo>("fetch_page_info", { url: normalizeUrl(url) });
        setPageInfo(info);
      } catch (e) {
        setInfoError(String(e));
      } finally {
        setInfoLoading(false);
      }
    }
  }

  // ── render ─────────────────────────────────────────────────────────
  const cookies = pageInfo?.headers.filter(([k]) => k.toLowerCase() === "set-cookie") ?? [];
  const nonCookieHeaders = pageInfo?.headers.filter(([k]) => k.toLowerCase() !== "set-cookie") ?? [];

  return (
    <div className="bp-root">
      <div className="bp-chrome">
        <button className="bp-nav-btn" title="Back/forward not supported" disabled>‹</button>
        <button className="bp-nav-btn" title="Forward not supported" disabled>›</button>
        <button className="bp-nav-btn" title="Refresh" onClick={handleRefresh} disabled={!wvReady || loading}>↺</button>

        <form className="bp-url-form" onSubmit={handleSubmit}>
          <div className="bp-url-bar">
            <span className="bp-url-lock">{loading ? <span className="bp-spinner" /> : "🔒"}</span>
            <input
              className="bp-url-input"
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onFocus={e => e.target.select()}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="Enter URL or search..."
            />
            <button type="submit" className="bp-go-btn" disabled={loading}>Go</button>
          </div>
        </form>

        <button
          className="bp-inspect-btn"
          onClick={handleInspectToggle}
          disabled={infoLoading}
          title="Toggle inspect panel (hides the browser while open)"
        >
          {infoLoading ? <span className="bp-spinner" /> : inspectOpen ? "✕ Close Inspect" : "⚙ Inspect"}
        </button>
      </div>

      {wvError && <div className="bp-error-bar">⚠ {wvError}</div>}

      <div className="bp-viewport" ref={viewportRef}>
        {!wvReady && !wvError && !inspectOpen && (
          <div className="bp-splash">
            <span className="bp-loading-ring" />
            <span>Initialising browser…</span>
          </div>
        )}

        {inspectOpen && (
          <div className="bp-inspect" style={{ position: "absolute", inset: 0, height: "auto" }}>
            <div className="bp-inspect-tabs">
              {(["headers", "info", "cookies"] as const).map(tab => (
                <button
                  key={tab}
                  className={`bp-tab ${inspectTab === tab ? "bp-tab-active" : ""}`}
                  onClick={() => setInspectTab(tab)}
                >
                  {tab === "headers" ? "🗂 Headers" : tab === "info" ? "ℹ Info" : "🍪 Cookies"}
                  {tab === "cookies" && cookies.length > 0 && (
                    <span className="bp-tab-badge">{cookies.length}</span>
                  )}
                </button>
              ))}
              <div className="bp-inspect-spacer" />
              {pageInfo && (
                <span className="bp-status-badge" style={{ color: statusColor(pageInfo.status) }}>
                  HTTP {pageInfo.status}
                </span>
              )}
              {infoLoading && <span className="bp-inspect-hint"><span className="bp-spinner" /> Fetching…</span>}
            </div>

            <div className="bp-inspect-body">
              {infoError && <div className="bp-inspect-error">⚠ {infoError}</div>}

              {!pageInfo && !infoLoading && !infoError && (
                <div className="bp-inspect-empty">No page data fetched yet.</div>
              )}

              {pageInfo && inspectTab === "headers" && (
                <table className="bp-header-table">
                  <tbody>
                    {nonCookieHeaders.map(([k, v], i) => (
                      <tr key={i} className="bp-header-row">
                        <td className="bp-header-key">{k}</td>
                        <td className="bp-header-val">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {pageInfo && inspectTab === "info" && (
                <div className="bp-info-grid">
                  <div className="bp-info-row"><span className="bp-info-label">Title</span><span className="bp-info-val">{pageInfo.title ?? "—"}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">URL</span><span className="bp-info-val bp-mono">{pageInfo.url}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">Final URL</span><span className="bp-info-val bp-mono">{pageInfo.final_url}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">Status</span><span className="bp-info-val" style={{ color: statusColor(pageInfo.status), fontWeight: 700 }}>{pageInfo.status}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">Content-Type</span><span className="bp-info-val bp-mono">{pageInfo.content_type ?? "—"}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">Content-Length</span><span className="bp-info-val bp-mono">{pageInfo.content_length != null ? `${pageInfo.content_length} bytes` : "—"}</span></div>
                  <div className="bp-info-row"><span className="bp-info-label">Server</span><span className="bp-info-val bp-mono">{pageInfo.server ?? "—"}</span></div>
                </div>
              )}

              {pageInfo && inspectTab === "cookies" && (
                cookies.length === 0
                  ? <div className="bp-inspect-empty">No Set-Cookie headers found in the response.</div>
                  : <div className="bp-cookie-list">
                    {cookies.map(([, v], i) => (
                      <div key={i} className="bp-cookie-row">
                        <span className="bp-cookie-icon">🍪</span>
                        <span className="bp-cookie-val">{v}</span>
                      </div>
                    ))}
                  </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}