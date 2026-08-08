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

// Mirrors the Rust-side profile_args() mapping — used to populate the
// editable "Command:" field, Zenmap-style, when a profile is picked.
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