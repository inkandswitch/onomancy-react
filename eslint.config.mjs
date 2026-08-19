import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// The library takes its keyhive and automerge values from the host
// application, so anything it does import should be a type-only import of the
// slim entry points. `check-isolation.mjs` enforces the runtime half of this
// against the built output; this catches the wrong path at author time.
const automergeSlimImportRule = {
  meta: { name: "enforce-automerge-slim-import" },
  create(context) {
    const fat = ["@automerge/automerge", "@automerge/automerge-repo"];
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        for (const pkg of fat) {
          if (source === pkg || source.startsWith(`${pkg}/`)) {
            if (source.startsWith(`${pkg}/slim`)) continue;
            context.report({
              node,
              message: `Import from ${pkg}/slim instead of ${pkg}`,
            });
          }
        }
      },
    };
  },
};

export default [
  {
    ignores: [
      "**/*.d.ts",
      "**/dist/*",
      "**/node_modules/*",
      "eslint.config.mjs",
      "**/vite.config.ts",
    ],
  },
  js.configs.recommended,
  ...compat.extends(
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended"
  ),
  {
    files: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "apps/*/src/**/*.ts",
      "apps/*/src/**/*.tsx",
    ],

    plugins: {
      "@typescript-eslint": typescriptEslint,
      "react-hooks": reactHooks,
      "automerge-slimport": {
        rules: { "enforce-automerge-slim-import": automergeSlimImportRule },
      },
    },

    languageOptions: {
      globals: { ...globals.browser },
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        project: ["./tsconfig.json", "./apps/component-test-app/tsconfig.json"],
      },
    },

    rules: {
      "@typescript-eslint/no-floating-promises": 2,
      "@typescript-eslint/no-empty-function": 0,
      "@typescript-eslint/no-non-null-assertion": 0,
      "@typescript-eslint/no-explicit-any": 0,
      "@typescript-eslint/no-unused-vars": [
        2,
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
      "automerge-slimport/enforce-automerge-slim-import": 2,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
];
