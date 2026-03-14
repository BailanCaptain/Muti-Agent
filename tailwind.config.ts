import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sand: {
          50: "#f7f2ea",
          100: "#efe2d0",
          200: "#dfc5a0",
          500: "#b4532a",
          700: "#7f3319",
          900: "#25160d"
        }
      },
      boxShadow: {
        soft: "0 20px 50px rgba(76, 43, 12, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
