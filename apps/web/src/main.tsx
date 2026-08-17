import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { createEventApi } from "./lib/api.js";
import { createPublicEventApi } from "./lib/public-api.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App
      api={
        import.meta.env.VITE_PUBLIC_MODE === "true"
          ? createPublicEventApi()
          : createEventApi()
      }
    />
  </StrictMode>
);
