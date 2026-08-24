// Flat config (ESLint 9). Syntactic typescript-eslint only — no type-checked rules,
// so linting stays fast and needs no tsconfig project wiring.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Prefer the type-aware unused-vars check; allow intentional _-prefixed args.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests lean on fixtures and partial shapes; keep the signal, drop the noise.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
