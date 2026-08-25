import next from "eslint-config-next";

// eslint-config-next registers @typescript-eslint inside its own config object.
// Flat config resolves plugin namespaces per object, so overrides for those
// rules have to be attached to an object that declares the plugin too.
const typescriptPlugins = next.find((entry) => entry.plugins?.["@typescript-eslint"])?.plugins ?? {};

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "supabase/functions/**",
      "scripts/**"
    ]
  },
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: typescriptPlugins,
    rules: {
      // Caught real dead code during the recency work: a scorer left behind
      // after its only caller was removed.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none"
      }],
      // Used deliberately at a few boundaries where the shape genuinely is
      // unknown. Worth seeing, not worth failing a build over.
      "@typescript-eslint/no-explicit-any": "warn"
    }
  },
  {
    // Next 16 ships React Compiler-aware hook rules, and they immediately found
    // 35 pre-existing findings across the UI - setState inside effects, refs
    // written during render. Several look like real bugs and one of them,
    // "Cannot update ref during render" in VaultPoolPreview, is the same class
    // of problem as the celebration effect that had to be fixed by hand.
    //
    // They are warnings rather than errors ONLY so that turning linting on does
    // not block every other piece of work behind a 35-item refactor of files
    // that are being actively edited. This is a backlog, not a decision that the
    // findings are acceptable: they should be worked through and promoted to
    // errors.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn"
    }
  }
];

export default config;
