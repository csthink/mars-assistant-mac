const js = require("@eslint/js");
const ts = require("typescript-eslint");
module.exports = ts.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    ...js.configs.recommended,
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  ...ts.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
);
