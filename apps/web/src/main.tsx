import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
// SF Pro where the system has it (macOS, iOS); Inter elsewhere. Doto for big numbers.
import "@fontsource-variable/inter/index.css";
import "@fontsource/doto/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { applyStoredTheme } from "./components/TopBar";

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 380, damping: 34 }}>
      <App />
    </MotionConfig>
  </StrictMode>,
);
