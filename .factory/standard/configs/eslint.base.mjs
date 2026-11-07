/**
 * Osnovna ESLint flat konfiguracija standarda tvornice: K4, K5, K7, K8, K17 i S5.
 * Pravila su u eslint.rules.json, a podjela na stilska i ispravnosna pravila u rule-classes.toml.
 * Traži paket typescript-eslint >= 8.15 i @eslint-community/eslint-plugin-eslint-comments.
 */
import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

const rules = JSON.parse(readFileSync(new URL("./eslint.rules.json", import.meta.url), "utf8"));

/**
 * Konfiguracija za jedan repo. `tsconfigRootDir` je korijen repoa za pravila koja traže tipove.
 */
export function factoryConfig({ tsconfigRootDir, files = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"] }) {
  return [
    { linterOptions: { reportUnusedDisableDirectives: "error" } },
    {
      files,
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { "@typescript-eslint": tseslint.plugin, "@eslint-community/eslint-comments": comments },
      rules,
    },
  ];
}

export default factoryConfig;
