import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./workspace-panel.css";
import "./AutomationPanel.css";
import "./orchestration.css";
import "./harness.css";
import "./desktop-browser.css";
import "./terminal.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
