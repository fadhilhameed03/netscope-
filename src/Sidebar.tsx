import { useState } from "react";

interface SubItem {
  id: string;
  label: string;
  enabled: boolean;
}

interface NavCategory {
  id: string;
  label: string;
  icon: string;
  count: number;
  items: SubItem[];
}

const TOP_LEVEL = [
  { id: "overview", label: "Overview", icon: "⌂", enabled: false },
  { id: "dashboard", label: "Dashboard", icon: "▦", enabled: false },
  { id: "notes", label: "Project Notes", icon: "▤", enabled: false },
];

const CATEGORIES: NavCategory[] = [
  { id: "recon", label: "Recon", icon: "◎", count: 0, items: [] },
  {
    id: "web",
    label: "Web",
    icon: "⌁",
    count: 1,
    items: [
      { id: "browser", label: "Browser", enabled: true },
    ],
  },
  {
    id: "vulnerabilities",
    label: "Vulnerabilities",
    icon: "⚑",
    count: 1,
    items: [
      { id: "nuclei", label: "Nuclei Scanner", enabled: true },
    ],
  },
  {
    id: "network",
    label: "Network",
    icon: "⚡",
    count: 2,
    items: [
      { id: "port-scanner", label: "Port Scanner", enabled: true },
      { id: "ettercap", label: "Ettercap", enabled: true },
      { id: "ssl-cert", label: "SSL / TLS Certificate", enabled: false },
    ],
  },
  { id: "fuzzing", label: "Fuzzing", icon: "▧", count: 0, items: [] },
  { id: "cloud", label: "Cloud", icon: "☁", count: 0, items: [] },
];

interface Props {
  activePage: string;
  onSelectPage: (id: string) => void;
}

export default function Sidebar({ activePage, onSelectPage }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ network: true, vulnerabilities: true, web: true });
  const [search, setSearch] = useState("");

  function toggleCategory(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const filteredCategories = CATEGORIES.map((cat) => {
    if (!search.trim()) return cat;
    const q = search.toLowerCase();
    const matchesCat = cat.label.toLowerCase().includes(q);
    const matchingItems = cat.items.filter((i) => i.label.toLowerCase().includes(q));
    if (matchesCat) return cat;
    return { ...cat, items: matchingItems };
  }).filter((cat) => !search.trim() || cat.label.toLowerCase().includes(search.toLowerCase()) || cat.items.length > 0);

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon">⌬</span>
        <span className="sidebar-brand-text">Red-Phantom</span>
        <span className="sidebar-brand-tag">PRO</span>
      </div>

      <div className="sidebar-top-nav">
        {TOP_LEVEL.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.enabled}
            className={`sidebar-nav-item ${!item.enabled ? "sidebar-nav-item-disabled" : ""}`}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-search">
        <span className="sidebar-search-icon">⌕</span>
        <input
          type="text"
          placeholder="Search modules or categories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sidebar-search-input"
        />
      </div>

      <nav className="sidebar-categories">
        {filteredCategories.map((cat) => {
          const isExpanded = search.trim() ? true : expanded[cat.id];
          const hasItems = cat.items.length > 0;
          return (
            <div key={cat.id} className="sidebar-category">
              <button
                type="button"
                className="sidebar-category-header"
                onClick={() => hasItems && toggleCategory(cat.id)}
              >
                <span className="sidebar-nav-icon">{cat.icon}</span>
                <span className="sidebar-category-label">{cat.label}</span>
                {cat.count > 0 && <span className="sidebar-category-count">{cat.count}</span>}
                {hasItems && (
                  <span className={`sidebar-category-chevron ${isExpanded ? "sidebar-category-chevron-open" : ""}`}>
                    ›
                  </span>
                )}
              </button>

              {hasItems && isExpanded && (
                <div className="sidebar-subitems">
                  {cat.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!item.enabled}
                      onClick={() => item.enabled && onSelectPage(item.id)}
                      className={`sidebar-subitem ${activePage === item.id ? "sidebar-subitem-active" : ""} ${!item.enabled ? "sidebar-nav-item-disabled" : ""}`}
                    >
                      {item.label}
                      {!item.enabled && <span className="sidebar-nav-soon">soon</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">28 modules</div>
    </div>
  );
}