/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2020: true,
    jest: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {
    // Prefer the TS-aware version and allow intentional unused args via `_`
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      // Keep this as a warning for now; TypeScript already enforces a lot via `strict`,
      // and we don't want lint to block builds on currently-existing dead code.
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // TS handles undefined names at type-check time; ESLint's no-undef is noisy for TS.
    'no-undef': 'off',
    // Keep as warnings (these pop up in a few string/guard patterns)
    'no-useless-escape': 'warn',
    'no-constant-condition': 'warn',
    // Native ESLint rule flags TS overload signatures as duplicate class
    // members. Disable it and use the TS-aware version which understands
    // overloaded function/method signatures. TypeScript itself still catches
    // real duplicates at type-check time.
    'no-dupe-class-members': 'off',
    '@typescript-eslint/no-dupe-class-members': 'error',
  },
};


