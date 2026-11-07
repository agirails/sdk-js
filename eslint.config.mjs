/**
 * Lint for @agirails/sdk: the factory standard (.factory/standard/configs/eslint.base.mjs) on top of
 * eslint:recommended. Every rule is an error.
 *
 * Violations that predate the standard are listed in .factory/eslint-suppressions.json, which may only
 * shrink: a new violation fails, and a fixed one fails until it is pruned with `npm run lint:prune`.
 *
 * Repo-specific settings:
 * - tests are outside tsconfig.json because they are not emitted, so typed rules read tsconfig.eslint.json;
 * - TypeScript reports undefined names, so the core no-undef rule is off;
 * - the core no-dupe-class-members rule flags overload signatures, so the TypeScript-aware rule replaces it;
 * - K17 bans console in library code; the CLI prints to the terminal by design and tests may log.
 */
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import factoryConfig from "./.factory/standard/configs/eslint.base.mjs";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default [
  { ignores: ["dist/", "node_modules/", ".factory/"] },
  { files: ["**/*.ts"], ...js.configs.recommended },
  ...factoryConfig({ tsconfigRootDir, files: ["**/*.ts"] }),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: false, project: ["./tsconfig.eslint.json"], tsconfigRootDir },
    },
    rules: {
      "no-undef": "off",
      "no-dupe-class-members": "off",
      "@typescript-eslint/no-dupe-class-members": "error",
    },
  },
  {
    files: ["src/cli/**/*.ts", "**/*.test.ts", "src/__tests__/**/*.ts", "src/__e2e__/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
