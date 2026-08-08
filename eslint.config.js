import eslint from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  { ignores: ["dist/**", "schemas/**", "node_modules/**"] },
  eslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        requireConfigFile: false,
        babelOptions: {
          presets: [
            ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
            ["@babel/preset-react", { runtime: "automatic" }],
          ],
        },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "no-unused-vars": "off",
      "no-undef": "off",
      "react-refresh/only-export-components": "off",
    },
  },
];
