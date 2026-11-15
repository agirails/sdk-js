/**
 * The base ESLint flat configuration of the factory standard: K4, K5, K7, K8, K17 and S5.
 * The rules are in eslint.rules.json, and the split into style and correctness rules is in rule-classes.toml.
 * Requires the package typescript-eslint >= 8.15 and @eslint-community/eslint-plugin-eslint-comments.
 */
import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

const rules = JSON.parse(readFileSync(new URL("./eslint.rules.json", import.meta.url), "utf8"));

/**
 * The configuration for one repo. `tsconfigRootDir` is the repo root for the rules that need types.
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
