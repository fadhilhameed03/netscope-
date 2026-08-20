import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface HostEntry {
  ip: string;
  mac: string;
  description: string;
}

interface ProgressEvent {
  message: string;
}

const DURATIONS = [
  { value: 15, label: "15s (quick)" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s (thorough)" },
];

function mergeHostsByIp(prev: HostEntry[], incoming: HostEntry[]): HostEntry[] {
  const map = new Map<string, HostEntry>();
  for (const h of prev) map.set(h.ip, h);
  for (const h of incoming) map.set(h.ip, h);
  return Array.from(map.values());
}

export default function EttercapPage() {
  const [iface, setIface] = useState("");
  const [duration, setDuration] = useState(30);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [mergeMode, setMergeMode] = useState(false);
  const logBodyRef = useRef<HTMLDivElement>(null);

  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const [gateway, setGateway] = useState("");
  const [mitmRunning, setMitmRunning] = useState(false);
  const [mitmStarting, setMitmStarting] = useState(false);
  const [mitmError, setMitmError] = useState("");
  const [mitmLog, setMitmLog] = useState<string[]>([]);
  const mitmLogBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("ettercap-progress", (event) => {
      setLog((prev) => [...prev.slice(-80), event.payload.message]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [log]);

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("ettercap-mitm-progress", (event) => {
      setMitmLog((prev) => [...prev.slice(-120), event.payload.message]);
      if (event.payload.message === "[session ended]") {
        setMitmRunning(false);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (mitmLogBodyRef.current) {
      mitmLogBodyRef.current.scrollTop = mitmLogBodyRef.current.scrollHeight;
    }
  }, [mitmLog]);

  async function handleDiscover(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setLog([]);
    if (!mergeMode) {
      setHosts([]);
      setSelectedIps(new Set());
    }
    try {
      const result = await invoke<HostEntry[]>("ettercap_discover_hosts", {
        iface,
        durationSecs: duration,
      });
      const merged = mergeMode ? mergeHostsByIp(hosts, result) : result;
      setHosts(merged);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleTarget(ip: string) {
    setSelectedIps((prev) => {
      const next = new Set(prev);
      if (next.has(ip)) {
        next.delete(ip);
      } else {
        next.add(ip);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIps((prev) => (prev.size === hosts.length ? new Set() : new Set(hosts.map((h) => h.ip))));
  }

  async function handleStartMitm() {
    setMitmError("");
    setMitmStarting(true);
    setMitmLog([]);
    try {
      await invoke("ettercap_start_mitm", {
        iface,
        targets: Array.from(selectedIps),
        gateway: gateway.trim() || null,
      });
      setMitmRunning(true);
    } catch (err) {
      setMitmError(String(err));
    } finally {
      setMitmStarting(false);
    }
  }

  async function handleStopMitm() {
    try {
      await invoke("ettercap_stop_mitm");
    } catch (err) {
      setMitmError(String(err));
    } finally {
      setMitmRunning(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-icon">🕸</div>
        <div>
          <h1 className="page-title">Ettercap</h1>
          <p className="page-subtitle">
            Host discovery, ARP MITM, and live sniffing via ettercap.
          </p>
        </div>
      </div>

      <form onSubmit={handleDiscover}>
        <div className="scan-form-row">
          <input
            type="text"
            placeholder="Interface (e.g. eth0, wlan0)"
            value={iface}
            onChange={(e) => setIface(e.target.value)}
            required
            className="target-input"
          />
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="profile-select"
          >
            {DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
          <button type="submit" disabled={loading} className="scan-btn">
            {loading ? "Discovering..." : "Discover Hosts"}
          </button>
        </div>

        <div className="command-row">
          <span className="command-label">Command:</span>
          <span className="command-fixed">ettercap -T -q -i</span>
          <span className="command-fixed">{iface || "<iface>"}</span>
          <span className="command-fixed">-o -k &lt;hosts_file&gt;</span>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", fontSize: "13px", color: "#7fbf9f" }}>
          <input type="checkbox" checked={mergeMode} onChange={(e) => setMergeMode(e.target.checked)} />
          Merge with previous scan (keep existing hosts, add new discoveries)
        </label>
      </form>

      {error && <div className="error-banner">Error: {error}</div>}

      {(loading || log.length > 0) && (
        <div className="terminal-panel" style={{ marginTop: "16px" }}>
          <div className="terminal-header">
            <span className="term-dot term-dot-red" />
            <span className="term-dot term-dot-yellow" />
            <span className="term-dot term-dot-green" />
            <span className="terminal-title">
              root@netscope: ~/ettercap — {loading ? `scanning (${duration}s)` : "done"}
            </span>
          </div>
          <div className="terminal-body" ref={logBodyRef}>
            {log.map((line, i) => (
              <div key={i} className="terminal-line">
                <span className="terminal-prompt">$</span> {line}
              </div>
            ))}
            {loading && (
              <div className="terminal-cursor-line">
                <span className="terminal-prompt">$</span> <span className="blink-cursor">▊</span>
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && hosts.length > 0 && (
        <div className="side-panel" style={{ marginTop: "16px" }}>
          <p style={{ color: "#7fbf9f", margin: "0 0 10px" }}>
            {hosts.length} host{hosts.length !== 1 ? "s" : ""} discovered — select targets for MITM
          </p>
          <table className="ettercap-host-table">
            <thead>
              <tr>
                <th style={{ width: "36px" }}>
                  <input
                    type="checkbox"
                    checked={selectedIps.size === hosts.length && hosts.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>IP</th>
                <th>MAC</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => (
                <tr key={h.ip}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIps.has(h.ip)}
                      onChange={() => toggleTarget(h.ip)}
                    />
                  </td>
                  <td>{h.ip}</td>
                  <td>{h.mac}</td>
                  <td>{h.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="scan-form-row" style={{ marginTop: "14px" }}>
            <input
              type="text"
              placeholder="Gateway IP (optional, e.g. 192.168.1.1)"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              className="target-input"
            />
            {!mitmRunning ? (
              <button
                type="button"
                onClick={handleStartMitm}
                disabled={selectedIps.size === 0 || mitmStarting}
                className="scan-btn"
              >
                {mitmStarting ? "Starting MITM..." : `Start MITM (${selectedIps.size} target${selectedIps.size !== 1 ? "s" : ""})`}
              </button>
            ) : (
              <button type="button" onClick={handleStopMitm} className="scan-btn">
                Stop MITM
              </button>
            )}
          </div>

          <div className="command-row" style={{ marginTop: "8px" }}>
            <span className="command-label">Command:</span>
            <span className="command-fixed">ettercap -T -q -i</span>
            <span className="command-fixed">{iface || "<iface>"}</span>
            <span className="command-fixed">-M arp:remote</span>
            <span className="command-fixed">
              {selectedIps.size > 0 ? `/${Array.from(selectedIps).join(",")}/` : "/<targets>/"}
            </span>
            <span className="command-fixed">{gateway.trim() ? `/${gateway.trim()}/` : "//"}</span>
          </div>

          {mitmError && <div className="error-banner" style={{ marginTop: "10px" }}>Error: {mitmError}</div>}

          {(mitmRunning || mitmLog.length > 0) && (
            <div className="terminal-panel" style={{ marginTop: "14px" }}>
              <div className="terminal-header">
                <span className="term-dot term-dot-red" />
                <span className="term-dot term-dot-yellow" />
                <span className="term-dot term-dot-green" />
                <span className="terminal-title">
                  root@netscope: ~/mitm — {mitmRunning ? "active" : "stopped"}
                </span>
              </div>
              <div className="terminal-body" ref={mitmLogBodyRef}>
                {mitmLog.map((line, i) => (
                  <div key={i} className="terminal-line">
                    <span className="terminal-prompt">$</span> {line}
                  </div>
                ))}
                {mitmRunning && (
                  <div className="terminal-cursor-line">
                    <span className="terminal-prompt">$</span> <span className="blink-cursor">▊</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && hosts.length === 0 && log.length > 0 && !error && (
        <div className="side-panel" style={{ marginTop: "16px" }}>
          <p style={{ color: "#7fbf9f", margin: 0 }}>
            Scan complete — no hosts found. Check the interface name and permissions (pkexec).
          </p>
        </div>
      )}
    </div>
  );
}