import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // supabase/functions is Deno code, lint with Deno tooling instead.
  { ignores: ["dist", "supabase/functions/**"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Was switched off entirely. An unused import or variable is usually a
      // leftover, and sometimes the symptom of a real mistake (a value
      // computed and then never used). Kept as a warning, with the usual
      // underscore escape hatch for deliberately ignored bindings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // shadcn/ui components are vendored from upstream and deliberately export
    // their variant helpers next to the component. Diverging from upstream to
    // silence a Fast Refresh hint would make every future update a conflict,
    // and the hint only affects hot reload in development. Scoped off here so
    // `npm run lint` stays at zero — a warning nobody can act on is noise that
    // hides the ones that matter.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
