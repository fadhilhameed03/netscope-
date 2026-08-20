import { useState } from "react";
import Sidebar from "./Sidebar";
import PortScannerPage from "./PortScannerPage";
import EttercapPage from "./EttercapPage";
import NucleiPage from "./NucleiPage";
import TitleBar from "./TitleBar";
import "./App.css";

function App() {
  const [activePage, setActivePage] = useState("port-scanner");

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-layout">
        <Sidebar activePage={activePage} onSelectPage={setActivePage} />
        <div className="app-content">
          <div style={{ display: activePage === "port-scanner" ? "block" : "none", height: "100%" }}>
            <PortScannerPage />
          </div>
          <div style={{ display: activePage === "ettercap" ? "block" : "none", height: "100%" }}>
            <EttercapPage />
          </div>
          <div style={{ display: activePage === "nuclei" ? "block" : "none", height: "100%" }}>
            <NucleiPage />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;