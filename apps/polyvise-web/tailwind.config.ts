import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#171717",
        graphite: "#2e3135",
        paper: "#f8f7f3",
        linen: "#efebe2",
        jade: "#227c70",
        moss: "#687a3e",
        saffron: "#c38326",
        coral: "#c9563f",
        plum: "#6d4b73"
      },
      boxShadow: {
        panel: "0 18px 48px rgba(23, 23, 23, 0.09)"
      }
    }
  },
  plugins: [require("@tailwindcss/typography")]
};

export default config;
