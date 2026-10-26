import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
import "@fontsource/sora/600.css";
import "@fontsource/sora/700.css";
import "@fontsource/zen-kaku-gothic-new/500.css";
import "@fontsource/shippori-mincho-b1/700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
