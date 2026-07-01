import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config. Lints the TypeScript sources; formatting is delegated to Prettier
// (eslint-config-prettier turns off any stylistic rules that would conflict).
export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "*.config.js", "*.config.cjs"] },
  ...tseslint.configs.recommended,
  prettier,
);
