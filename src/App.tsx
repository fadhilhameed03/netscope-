import { useState } from "react";
import Sidebar from "./Sidebar";
import PortScannerPage from "./PortScannerPage";
import EttercapPage from "./EttercapPage";
import NucleiPage from "./NucleiPage";
import BrowserPage from "./BrowserPage";
import "./App.css";

function App() {
  const [activePage, setActivePage] = useState("port-scanner");

  const isBrowser = activePage === "browser";

  return (
    <div className="app-root">
      <div className="app-layout">
        <Sidebar activePage={activePage} onSelectPage={setActivePage} />
        <div className="app-content" style={isBrowser ? { padding: 0, overflow: "hidden" } : undefined}>
          <div style={{ display: activePage === "port-scanner" ? "block" : "none", height: "100%" }}>
            <PortScannerPage />
          </div>
          <div style={{ display: activePage === "ettercap" ? "block" : "none", height: "100%" }}>
            <EttercapPage />
          </div>
          <div style={{ display: activePage === "nuclei" ? "block" : "none", height: "100%" }}>
            <NucleiPage />
          </div>
          <div style={{ display: isBrowser ? "flex" : "none", height: "100%", flexDirection: "column" }}>
            <BrowserPage visible={isBrowser} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;