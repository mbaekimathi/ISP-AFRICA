import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--background-rgb) / <alpha-value>)",
        foreground: "rgb(var(--foreground-rgb) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--surface-rgb) / <alpha-value>)",
          muted: "rgb(var(--surface-muted-rgb) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "rgb(var(--primary-rgb) / <alpha-value>)",
          foreground: "rgb(var(--primary-foreground-rgb) / <alpha-value>)",
          hover: "rgb(var(--primary-hover-rgb) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--secondary-rgb) / <alpha-value>)",
          foreground: "rgb(var(--secondary-foreground-rgb) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--muted-rgb) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground-rgb) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground-rgb) / <alpha-value>)",
        },
        border: "rgb(var(--border-rgb) / <alpha-value>)",
        ring: "rgb(var(--ring-rgb) / <alpha-value>)",
        success: {
          DEFAULT: "rgb(var(--success-rgb) / <alpha-value>)",
          foreground: "rgb(var(--success-foreground-rgb) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--warning-rgb) / <alpha-value>)",
          foreground: "rgb(var(--warning-foreground-rgb) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--destructive-rgb) / <alpha-value>)",
          foreground: "rgb(var(--destructive-foreground-rgb) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          muted: "var(--sidebar-muted)",
          border: "var(--sidebar-border)",
          active: "var(--sidebar-active)",
        },
      },
      fontFamily: {
        sans: [
          '"Plus Jakarta Sans"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      boxShadow: {
        card: "var(--shadow-card)",
        header: "var(--shadow-header)",
        lift: "var(--shadow-lift)",
      },
      borderRadius: {
        lg: "var(--radius)",
        xl: "calc(var(--radius) + 0.25rem)",
        "2xl": "calc(var(--radius) + 0.5rem)",
      },
      maxWidth: {
        page: "var(--page-max)",
      },
      height: {
        header: "var(--header-height)",
      },
      width: {
        sidebar: "var(--sidebar-width)",
        "sidebar-collapsed": "var(--sidebar-width-collapsed)",
      },
      transitionDuration: {
        brand: "var(--duration)",
      },
      transitionTimingFunction: {
        brand: "var(--ease)",
      },
    },
  },
  plugins: [],
};

export default config;
