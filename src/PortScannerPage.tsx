import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Topology from "./Topology";
import RackTopology from "./RackTopology";
import Dashboard from "./Dashboard";
import { HostInfo, VulnInfo, ExploitInfo, SCAN_PROFILES, PROFILE_ARGS } from "./types";
import { exportAsJson, exportAsCsv, exportAsTxt } from "./export";
import { checkVulnerabilities } from "./vuln";
import { searchExploitDb } from "./exploit";
import { openUrl } from "@tauri-apps/plugin-opener";

interface ProgressEvent {
  message: string;
  percent: number | null;
}

function mergeHostsByIp(prev: HostInfo[], incoming: HostInfo[]): HostInfo[] {
  const map = new Map<string, HostInfo>();
  for (const h of prev) map.set(h.ip, h);
  for (const h of incoming) map.set(h.ip, h);
  return Array.from(map.values());
}

export default function PortScannerPage() {
  const [target, setTarget] = useState("");
  const [profile, setProfile] = useState("ping_sweep");
  const [customArgs, setCustomArgs] = useState(PROFILE_ARGS["ping_sweep"]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [percent, setPercent] = useState<number | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logBodyRef = useRef<HTMLDivElement>(null);

  const [vulnMap, setVulnMap] = useState<Record<string, VulnInfo[]>>({});
  const [vulnLoading, setVulnLoading] = useState(false);
  const [vulnLog, setVulnLog] = useState<string[]>([]);
  const vulnLogEndRef = useRef<HTMLDivElement>(null);
  const vulnLogBodyRef = useRef<HTMLDivElement>(null);

  const [exploitMap, setExploitMap] = useState<Record<string, ExploitInfo[]>>({});
  const [exploitLoadingKey, setExploitLoadingKey] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"graph" | "rack">("graph");

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("scan-progress", (event) => {
      setProgressLog((prev) => [...prev.slice(-50), event.payload.message]);
      if (event.payload.percent !== null) {
        setPercent(event.payload.percent);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("vuln-progress", (event) => {
      setVulnLog((prev) => [...prev.slice(-50), event.payload]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [progressLog]);

  useEffect(() => {
    if (vulnLogBodyRef.current) {
      vulnLogBodyRef.current.scrollTop = vulnLogBodyRef.current.scrollHeight;
    }
  }, [vulnLog]);

  function handleProfileChange(newProfile: string) {
    setProfile(newProfile);
    setCustomArgs(PROFILE_ARGS[newProfile] ?? "-T4 -F");
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setProgressLog([]);
    setPercent(0);
    setVulnLog([]);
    if (!mergeMode) {
      setHosts([]);
      setSelectedIp(null);
      setVulnMap({});
      setExploitMap({});
    }
    try {
      const result = await invoke<HostInfo[]>("scan_network", {
        target,
        profile,
        customArgs: customArgs.trim() || null,
      });
      const merged = mergeMode ? mergeHostsByIp(hosts, result) : result;
      setHosts(merged);
      const stillSelected = selectedIp && merged.some((h) => h.ip === selectedIp && h.state === "up");
      if (!stillSelected) {
        const firstUp = merged.find((h) => h.state === "up");
        if (firstUp) setSelectedIp(firstUp.ip);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setPercent(null);
    }
  }

  async function handleCheckVulns() {
    setVulnLoading(true);
    setVulnLog([]);
    try {
      const result = await checkVulnerabilities(upHosts);
      setVulnMap(result);
    } catch (err) {
      setVulnLog((prev) => [...prev, `Error: ${String(err)}`]);
    } finally {
      setVulnLoading(false);
    }
  }

  function openCve(cveId: string) {
    openUrl(`https://nvd.nist.gov/vuln/detail/${cveId}`).catch((err) => {
      console.error("Failed to open CVE link:", err);
    });
  }

  function openExploit(edbId: string) {
    openUrl(`https://www.exploit-db.com/exploits/${edbId}`).catch((err) => {
      console.error("Failed to open exploit link:", err);
    });
  }

  async function handleSearchExploits(portKey: string, product: string, version: string) {
    setExploitLoadingKey(portKey);
    try {
      const query = `${product} ${version}`.trim();
      const results = await searchExploitDb(query);
      setExploitMap((prev) => ({ ...prev, [portKey]: results }));
    } catch (err) {
      console.error("Exploit search failed:", err);
      setExploitMap((prev) => ({ ...prev, [portKey]: [] }));
    } finally {
      setExploitLoadingKey(null);
    }
  }

  const upHosts = useMemo(() => hosts.filter((h) => h.state === "up"), [hosts]);

  const terminalPanel = (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="term-dot term-dot-red" />
        <span className="term-dot term-dot-yellow" />
        <span className="term-dot term-dot-green" />
        <span className="terminal-title">
          root@netscope: ~/scan — {percent !== null ? `${percent.toFixed(1)}%` : loading ? "..." : "done"}
        </span>
      </div>
      <div className="terminal-progress-track">
        <div className="terminal-progress-fill" style={{ width: `${percent ?? 100}%` }} />
      </div>
      <div className="terminal-body" ref={logBodyRef}>
        {progressLog.map((line, i) => (
          <div key={i} className="terminal-line">
            <span className="terminal-prompt">$</span> {line}
          </div>
        ))}
        {loading && (
          <div className="terminal-cursor-line">
            <span className="terminal-prompt">$</span> <span className="blink-cursor">▊</span>
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-icon">⚡</div>
        <div>
          <h1 className="page-title">Port Scanner</h1>
          <p className="page-subtitle">TCP scan with nmap. Supports single hosts, IP ranges, and CIDR blocks.</p>
        </div>
      </div>

      <form onSubmit={handleScan}>
        <div className="scan-form-row">
          <input
            type="text"
            placeholder="Target IP or range (e.g. 192.168.1.0/24)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
            className="target-input"
          />
          <select value={profile} onChange={(e) => handleProfileChange(e.target.value)} className="profile-select">
            {SCAN_PROFILES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <button type="submit" disabled={loading} className="scan-btn">
            {loading ? "Scanning..." : "Scan"}
          </button>
        </div>

        <div className="command-row">
          <span className="command-label">Command:</span>
          <span className="command-fixed">nmap</span>
          <input
            type="text"
            value={customArgs}
            onChange={(e) => setCustomArgs(e.target.value)}
            className="command-input"
            spellCheck={false}
          />
          <span className="command-fixed">{target || "<target>"}</span>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", fontSize: "13px", color: "#7fbf9f" }}>
          <input type="checkbox" checked={mergeMode} onChange={(e) => setMergeMode(e.target.checked)} />
          Merge with previous scan (keep existing hosts, add/update new results)
        </label>
      </form>

      {error && <div className="error-banner">Error: {error}</div>}

      {(loading || upHosts.length > 0) && (
        <div className="scan-results-grid" style={{ marginTop: "16px" }}>
          <div>
            <div className="view-toggle">
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "graph" ? "view-toggle-btn-active" : ""}`}
                onClick={() => setViewMode("graph")}
              >
                Graph View
              </button>
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "rack" ? "view-toggle-btn-active" : ""}`}
                onClick={() => setViewMode("rack")}
              >
                Rack View
              </button>
            </div>

            {upHosts.length > 0 ? (
              viewMode === "graph" ? (
                <Topology hosts={upHosts} scanTarget={target} selectedIp={selectedIp} onSelectHost={setSelectedIp} />
              ) : (
                <RackTopology hosts={upHosts} selectedIp={selectedIp} onSelectHost={setSelectedIp} />
              )
            ) : (
              <div className="topology-placeholder">
                <div className="topology-placeholder-pulse" />
                <p>{loading ? "Mapping the network as results come in..." : "No hosts found."}</p>
              </div>
            )}
          </div>

          <div className="side-panel">
            {terminalPanel}

            {upHosts.length > 0 && (
              <>
                <div className="action-row" style={{ marginTop: "14px" }}>
                  <button type="button" onClick={() => exportAsJson(upHosts, target)} className="export-btn">
                    JSON
                  </button>
                  <button type="button" onClick={() => exportAsCsv(upHosts)} className="export-btn">
                    CSV
                  </button>
                  <button type="button" onClick={() => exportAsTxt(upHosts, target)} className="export-btn">
                    TXT
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleCheckVulns}
                  disabled={vulnLoading}
                  className="export-btn vuln-btn"
                >
                  {vulnLoading ? "Checking CVEs..." : "Check Vulnerabilities (CVE)"}
                </button>

                {(vulnLoading || vulnLog.length > 0) && (
                  <div className="terminal-panel vuln-log-panel" style={{ marginTop: "10px" }}>
                    <div className="terminal-header">
                      <span className="term-dot term-dot-red" />
                      <span className="term-dot term-dot-yellow" />
                      <span className="term-dot term-dot-green" />
                      <span className="terminal-title">vuln-check</span>
                    </div>
                    <div className="terminal-body" style={{ maxHeight: "120px" }} ref={vulnLogBodyRef}>
                      {vulnLog.map((line, i) => (
                        <div key={i} className="terminal-line">
                          <span className="terminal-prompt">$</span> {line}
                        </div>
                      ))}
                      <div ref={vulnLogEndRef} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!loading && upHosts.length === 0 && progressLog.length > 0 && (
        <div className="side-panel" style={{ marginTop: "16px" }}>
          <p style={{ color: "#7fbf9f", margin: 0 }}>
            Scan complete — no hosts found up. Double-check the target IP/range and try again.
          </p>
        </div>
      )}

      {upHosts.length > 0 && (
        <div style={{ marginTop: "16px" }}>
          <Dashboard
            hosts={upHosts}
            vulnMap={vulnMap}
            exploitMap={exploitMap}
            exploitLoadingKey={exploitLoadingKey}
            onSearchExploits={handleSearchExploits}
            onOpenCve={openCve}
            onOpenExploit={openExploit}
          />
        </div>
      )}
    </div>
  );
}