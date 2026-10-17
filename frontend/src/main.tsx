import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { ThemeProvider } from "@/providers/ThemeProvider";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@/styles/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
