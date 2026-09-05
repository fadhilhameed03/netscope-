import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

interface NativeBrowserState {
  url: string;
  title: string | null;
  loading: boolean;
  can_go_back: boolean;
  can_go_forward: boolean;
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

// ── component ──────────────────────────────────────────────────────────
// Drives a real WebKitWebView positioned via gtk::Fixed in the Rust
// backend (see native_browser.rs) instead of Tauri's own JS multiwebview
// API — that API places child webviews in a plain gtk::Box, which has no
// absolute-positioning support at all, hence the persistent mispositioning
// bug. Talking to GTK directly gives genuine pixel-accurate placement plus
// real back/forward/reload since we drive WebKit ourselves.
export default function BrowserPage({ visible }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [urlInput, setUrlInput] = useState("https://www.google.com");
  const [currentUrl, setCurrentUrl] = useState("");
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Inspect overlay (hides the native webview while open — see note in
  // navigate/visibility effects below on why it can't share space inline)
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectTab, setInspectTab] = useState<"headers" | "info" | "cookies">("headers");
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);

  const getViewportRect = useCallback(() => {
    if (!viewportRef.current) return null;
    const rect = viewportRef.current.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return null;
    return rect;
  }, []);

  const syncBounds = useCallback(() => {
    const rect = getViewportRect();
    if (!rect) return;
    invoke("native_browser_set_bounds", {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }).catch(() => { });
  }, [getViewportRect]);

  const navigate = useCallback(async (rawUrl: string) => {
    const url = normalizeUrl(rawUrl);
    if (!url || url === "about:blank") return;
    const rect = getViewportRect();
    if (!rect) return;
    setLoading(true);
    setBrowserError(null);
    try {
      await invoke("native_browser_navigate", {
        url,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      setCurrentUrl(url);
      setUrlInput(url);
      setInitialized(true);
    } catch (e) {
      setBrowserError(String(e));
      setLoading(false);
    }
  }, [getViewportRect]);

  // Listen for real WebKit navigation state (loading, title, back/forward
  // availability) pushed from the Rust side.
  useEffect(() => {
    const unlisten = listen<NativeBrowserState>("native-browser-state", (event) => {
      const s = event.payload;
      setLoading(s.loading);
      setPageTitle(s.title);
      setCanGoBack(s.can_go_back);
      setCanGoForward(s.can_go_forward);
      if (s.url) {
        setCurrentUrl(s.url);
        setUrlInput(s.url);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Create lazily the first time the page is actually visible — creating
  // while hidden measures a 0×0 rect and bakes in bad bounds.
  useEffect(() => {
    if (!visible || initialized) return;
    navigate("https://www.google.com");
  }, [visible, initialized, navigate]);

  // Show/hide (and resync bounds on show) whenever visibility or the
  // Inspect overlay toggles.
  useEffect(() => {
    if (!initialized) return;
    const shouldShow = visible && !inspectOpen;
    invoke("native_browser_set_visible", { visible: shouldShow }).catch(() => { });
    if (shouldShow) syncBounds();
  }, [visible, inspectOpen, initialized, syncBounds]);

  // Continuously track the viewport div's actual box.
  useEffect(() => {
    if (!viewportRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (visible && !inspectOpen) syncBounds();
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [visible, inspectOpen, syncBounds]);

  useEffect(() => {
    const onResize = () => { if (visible && !inspectOpen) syncBounds(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [visible, inspectOpen, syncBounds]);

  // ── handlers ───────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(urlInput);
  }

  function handleBack() {
    invoke("native_browser_go_back").catch(() => { });
  }

  function handleForward() {
    invoke("native_browser_go_forward").catch(() => { });
  }

  function handleRefresh() {
    invoke("native_browser_refresh").catch(() => { });
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
      {/* ── Address bar ── */}
      <div className="bp-chrome">
        <button className="bp-nav-btn" title="Back" onClick={handleBack} disabled={!canGoBack}>‹</button>
        <button className="bp-nav-btn" title="Forward" onClick={handleForward} disabled={!canGoForward}>›</button>
        <button className="bp-nav-btn" title="Refresh" onClick={handleRefresh} disabled={!initialized || loading}>↺</button>

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
              title={pageTitle ?? undefined}
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

      {browserError && <div className="bp-error-bar">⚠ {browserError}</div>}

      {/* ── Viewport — native webview overlays this div when Inspect is closed ── */}
      <div className="bp-viewport" ref={viewportRef}>
        {!initialized && !browserError && !inspectOpen && (
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