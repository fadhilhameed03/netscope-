import { useState, useMemo } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import type { HostInfo, VulnInfo, ExploitInfo } from "./types";

interface FlatRow {
  host: string;
  hostname: string;
  ip: string;
  port: number;
  protocol: string;
  state: string;
  service: string;
  product: string;
  version: string;
  key: string; // "ip:port"
}

interface Props {
  hosts: HostInfo[];
  vulnMap: Record<string, VulnInfo[]>;
  exploitMap: Record<string, ExploitInfo[]>;
  exploitLoadingKey: string | null;
  onSearchExploits: (key: string, product: string, version: string) => void;
  onOpenCve: (cveId: string) => void;
  onOpenExploit: (edbId: string) => void;
}

const SEVERITY_COLORS = {
  high: "#ff6b6b",
  medium: "#ffb45a",
  low: "#ffe65a",
  unknown: "#aaaaaa",
};

const SERVICE_COLORS = ["#3fae7a", "#5a7dc9", "#c96ea0", "#c9a227", "#7a5ac9", "#4dbdbd"];

function severityBucket(score: number | null): keyof typeof SEVERITY_COLORS {
  if (score === null) return "unknown";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export default function Dashboard({
  hosts,
  vulnMap,
  exploitMap,
  exploitLoadingKey,
  onSearchExploits,
  onOpenCve,
  onOpenExploit,
}: Props) {
  const [filter, setFilter] = useState("");

  const rows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    for (const h of hosts) {
      for (const p of h.ports) {
        out.push({
          host: h.hostname || h.ip,
          hostname: h.hostname,
          ip: h.ip,
          port: p.port,
          protocol: p.protocol,
          state: p.state,
          service: p.service,
          product: p.product,
          version: p.version,
          key: `${h.ip}:${p.port}`,
        });
      }
    }
    return out.sort((a, b) => (a.ip === b.ip ? a.port - b.port : a.ip.localeCompare(b.ip)));
  }, [hosts]);

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter(
      (r) =>
        r.ip.includes(q) ||
        r.hostname.toLowerCase().includes(q) ||
        String(r.port).includes(q) ||
        r.service.toLowerCase().includes(q) ||
        r.product.toLowerCase().includes(q)
    );
  }, [rows, filter]);

  const totalPorts = rows.length;
  const totalHosts = hosts.length;
  const allVulns = Object.values(vulnMap).flat();
  const resolvedCount = Object.keys(vulnMap).length;

  const severityData = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, unknown: 0 };
    allVulns.forEach((v) => {
      counts[severityBucket(v.severity)]++;
    });
    return (Object.keys(counts) as (keyof typeof counts)[])
      .filter((k) => counts[k] > 0)
      .map((k) => ({ name: k.toUpperCase(), value: counts[k], color: SEVERITY_COLORS[k] }));
  }, [allVulns]);

  const serviceData = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((r) => {
      const svc = r.service || "unknown";
      counts[svc] = (counts[svc] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value], i) => ({ name, value, color: SERVICE_COLORS[i % SERVICE_COLORS.length] }));
  }, [rows]);

  return (
    <div className="dashboard">
      {/* Stat cards */}
      <div className="stat-card-row">
        <div className="stat-card">
          <div className="stat-card-label"><span className="stat-dot stat-dot-green" />OPEN PORTS</div>
          <div className="stat-card-value">{totalPorts}</div>
          <div className="stat-card-bar"><div className="stat-card-bar-fill" style={{ width: "100%", background: "linear-gradient(90deg,#3fae7a,#7fffb0)" }} /></div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label"><span className="stat-dot stat-dot-teal" />HOSTS UP</div>
          <div className="stat-card-value">{totalHosts}</div>
          <div className="stat-card-bar"><div className="stat-card-bar-fill" style={{ width: "100%", background: "linear-gradient(90deg,#4dbdbd,#7fe0e0)" }} /></div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label"><span className="stat-dot stat-dot-orange" />CVES FOUND</div>
          <div className="stat-card-value">{allVulns.length}</div>
          <div className="stat-card-bar"><div className="stat-card-bar-fill" style={{ width: allVulns.length > 0 ? "100%" : "0%", background: "linear-gradient(90deg,#ff9d5c,#ffb45a)" }} /></div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label"><span className="stat-dot stat-dot-gray" />CVE-CHECKED</div>
          <div className="stat-card-value">{resolvedCount}</div>
          <div className="stat-card-bar"><div className="stat-card-bar-fill" style={{ width: totalPorts > 0 ? `${(resolvedCount / totalPorts) * 100}%` : "0%", background: "linear-gradient(90deg,#888,#bbb)" }} /></div>
        </div>
      </div>

      {/* Charts row */}
      <div className="chart-row">
        <div className="side-panel chart-panel">
          <h3 className="panel-heading">CVE Severity</h3>
          {severityData.length === 0 ? (
            <p style={{ color: "#666" }}>No CVE data yet. Run "Check Vulnerabilities" below.</p>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <ResponsiveContainer width={160} height={160}>
                <PieChart>
                  <Pie data={severityData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={3}>
                    {severityData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#141a14", border: "1px solid #2e7d5b", borderRadius: 4 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="legend-list">
                {severityData.map((d) => (
                  <div key={d.name} className="legend-row">
                    <span className="legend-dot" style={{ background: d.color }} />
                    {d.name} · {d.value}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="side-panel chart-panel">
          <h3 className="panel-heading">Top Services</h3>
          {serviceData.length === 0 ? (
            <p style={{ color: "#666" }}>No ports found.</p>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={serviceData} layout="vertical" margin={{ left: 10, right: 10 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" tick={{ fill: "#9fbfae", fontSize: 12 }} width={70} />
                <Tooltip contentStyle={{ background: "#141a14", border: "1px solid #2e7d5b", borderRadius: 4 }} cursor={{ fill: "rgba(63,174,122,0.05)" }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {serviceData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Results table */}
      <div className="side-panel">
        <div className="table-toolbar">
          <h3 className="panel-heading" style={{ margin: 0 }}>Results ({filteredRows.length} rows)</h3>
          <input
            type="text"
            placeholder="Filter rows..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="table-filter-input"
          />
        </div>

        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Host</th>
                <th>IP</th>
                <th>Port</th>
                <th>State</th>
                <th>Service</th>
                <th>Version</th>
                <th>CVEs</th>
                <th>Exploits</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const vulns = vulnMap[r.key];
                const exploits = exploitMap[r.key];
                return (
                  <tr key={r.key + r.port}>
                    <td>{r.host}</td>
                    <td className="mono">{r.ip}</td>
                    <td className="mono">{r.port}/{r.protocol}</td>
                    <td><span className="table-state-badge">{r.state}</span></td>
                    <td>{r.service || "—"}</td>
                    <td className="dim">{r.product} {r.version}</td>
                    <td>
                      {vulns && vulns.length > 0 ? (
                        <div className="table-badge-list">
                          {vulns.map((v) => (
                            <span
                              key={v.cve_id}
                              className={`cve-badge cve-badge-${severityBucket(v.severity)}`}
                              onClick={() => onOpenCve(v.cve_id)}
                              title={v.summary}
                            >
                              {v.cve_id}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td>
                      {exploits ? (
                        exploits.length === 0 ? (
                          <span className="dim">none</span>
                        ) : (
                          <div className="table-badge-list">
                            {exploits.map((ex) => (
                              <span
                                key={ex.edb_id}
                                className="exploit-mini-badge"
                                onClick={() => onOpenExploit(ex.edb_id)}
                                title={ex.title}
                              >
                                EDB-{ex.edb_id}
                              </span>
                            ))}
                          </div>
                        )
                      ) : (
                        <button
                          type="button"
                          className="table-mini-btn"
                          disabled={exploitLoadingKey === r.key || !r.product}
                          onClick={() => onSearchExploits(r.key, r.product, r.version)}
                        >
                          {exploitLoadingKey === r.key ? "..." : "Search"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "#666", padding: "20px" }}>
                    No rows match your filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}