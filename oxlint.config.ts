import { defineConfig } from "oxlint"

export default defineConfig({
  plugins: ["import", "typescript", "unicorn", "oxc", "promise"],
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error"
  },
  env: {
    builtin: true,
    es2024: true
  },
  ignorePatterns: [
    "node_modules",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**"
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./node_modules/oxlint-plugin-anti-slop/src/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./node_modules/oxlint-plugin-anti-slop/src/effect/index.ts"
    }
  ],
  rules: {
    "eslint/eqeqeq": ["error", "always"],
    "eslint/no-shadow": "error",
    "eslint/no-var": "error",
    "eslint/prefer-const": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "eslint/no-underscore-dangle": "off",
    "eslint/no-await-in-loop": "off",
    "unicorn/consistent-function-scoping": "off",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-service-constructor-imports": "error"
  }
})
