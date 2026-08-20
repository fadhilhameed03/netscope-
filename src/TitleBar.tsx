import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div
      className="titlebar"
      onMouseDown={(e) => {
        // Only start dragging from empty space, not from the buttons themselves.
        if ((e.target as HTMLElement).closest(".titlebar-btn")) return;
        appWindow.startDragging();
      }}
    >
      <div className="titlebar-left">
        <span className="titlebar-icon"></span>
        <span className="titlebar-label"></span>
      </div>

      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          &#8211;
        </button>
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          aria-label="Maximize"
        >
          {isMaximized ? "❐" : "☐"}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          &#10005;
        </button>
      </div>
    </div>
  );
}