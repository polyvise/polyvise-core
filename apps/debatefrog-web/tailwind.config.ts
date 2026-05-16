import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#182320",
        mud: "#5f4a38",
        pond: "#0d4f45",
        leaf: "#44a15f",
        leafDark: "#218b56",
        mint: "#dff5dc",
        cream: "#fff7dd",
        sun: "#f4c95d",
        berry: "#d45f7a",
        panel: "#fffdf2",
        lily: "#e9c9d6"
      },
      fontFamily: {
        rounded: ["ui-rounded", "Avenir Next", "Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"]
      },
      boxShadow: {
        lily: "0 18px 38px rgba(13, 79, 69, 0.18)",
        pop: "0 10px 22px rgba(212, 95, 122, 0.25)"
      }
    }
  },
  plugins: []
};

export default config;
