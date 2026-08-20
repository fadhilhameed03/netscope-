export interface PortInfo {
  port: number;
  protocol: string;
  state: string;
  service: string;
  product: string;
  version: string;
}

export interface HostInfo {
  ip: string;
  hostname: string;
  state: string;
  os: string;
  mac: string;
  vendor: string;
  ports: PortInfo[];
}

export interface VulnInfo {
  cve_id: string;
  severity: number | null;
  summary: string;
}

export const SCAN_PROFILES = [
  { value: "ping_sweep", label: "Ping Sweep (fast, discovery only)" },
  { value: "quick", label: "Quick Scan (top 100 ports)" },
  { value: "version", label: "Version Detection" },
  { value: "script_scan", label: "Script Scan (NSE + version)" },
  { value: "intense", label: "Intense (OS + version + scripts) — needs root" },
  { value: "stealth_syn", label: "Stealth SYN Scan — needs root" },
  { value: "os_detect", label: "OS Detection — needs root" },
  { value: "full_port", label: "Full Port Range (all 65535)" },
];

export const PROFILE_ARGS: Record<string, string> = {
  ping_sweep: "-sn",
  quick: "-T4 -F",
  version: "-sV",
  script_scan: "-sC -sV",
  intense: "-T4 -A",
  stealth_syn: "-sS -T2",
  os_detect: "-O",
  full_port: "-p- -T4",
};

export interface ExploitInfo {
  title: string;
  edb_id: string;
  path: string;
}

export interface NucleiFinding {
  template_id: string;
  name: string;
  severity: string;
  host: string;
  matched_at: string;
  description: string;
  tags: string[];
  reference: string[];
  cve_id: string | null;
}

// Common nuclei template tags. Selecting none runs nuclei's default set.
export const NUCLEI_TAGS = [
  "cves",
  "vulnerabilities",
  "exposures",
  "exposed-panels",
  "misconfiguration",
  "default-logins",
  "takeovers",
  "network",
  "dns",
  "ssl",
  "technologies",
  "fuzzing",
];

export const NUCLEI_SEVERITIES = ["critical", "high", "medium", "low", "info", "unknown"];