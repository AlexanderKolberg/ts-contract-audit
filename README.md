# ts-contract-audit

Find handwritten TypeScript object types that duplicate, or select fields from, generated contracts. Each match gets an explainable **0–100 heuristic confidence score**.

This is a local, advisory audit tool—not a lint rule, a probability model, or an automatic refactoring tool. Matching fields do not prove that two types represent the same concept.

## Install

Requires **Node.js 24+**. Install your target project's dependencies first so its imports can resolve.

```sh
git clone https://github.com/AlexanderKolberg/ts-contract-audit.git
cd ts-contract-audit
make install
make demo
```

Run the CLI directly with `node bin/ts-contract-audit.mjs`, or install it locally as a command:

```sh
npm install --global . --ignore-scripts
ts-contract-audit --help
```

The package is not published to npm. Its manifest is private to prevent accidental publication.

## Configure an audit

Create `ts-contract-audit.json` in your project:

```json
{
  "name": "app",
  "tsconfig": "tsconfig.json",
  "sources": ["src/**/*.ts", "src/**/*.tsx"],
  "contracts": ["src/api/generated.ts"],
  "exclude": ["src/vendor/**"]
}
```

All paths and globs resolve relative to the config file, or its optional `root` directory. `contracts` can point to declarations inside an installed SDK, such as `node_modules/example-sdk/dist/types.d.ts`. Package symlinks are resolved before matching.

```sh
ts-contract-audit --config /path/to/project/ts-contract-audit.json
ts-contract-audit --config /path/to/project/ts-contract-audit.json --min-confidence 75
ts-contract-audit --config /path/to/project/ts-contract-audit.json --format json > audit.json
ts-contract-audit --config /path/to/project/ts-contract-audit.json --format markdown --output audit.md
```

Without `--output`, results go to stdout and progress goes to stderr. `--output` creates a new file and refuses to overwrite an existing one. No application files are changed.

The default text/Markdown limit is 20 sites per project. `--limit 100` shows more. JSON contains every site above the confidence threshold, with up to `maxMatches` alternatives per site; it ignores `--limit`.

Multiple projects can share a config:

```json
{
  "root": ".",
  "projects": [
    {
      "name": "frontend",
      "tsconfig": "frontend/tsconfig.json",
      "sources": ["frontend/src/**/*.ts", "frontend/src/**/*.tsx"],
      "contracts": ["frontend/src/api/generated.ts"]
    },
    {
      "name": "admin",
      "tsconfig": "admin/tsconfig.json",
      "sources": ["admin/src/**/*.ts", "admin/src/**/*.tsx"],
      "contracts": ["admin/src/api/generated.ts"]
    }
  ]
}
```

Use `--project frontend` to select one. Each project runs in its own process. Git is not required for analysis.

Optional project settings:

- `minFields`: minimum number of fields to compare; default 2, minimum 2.
- `maxMatches`: alternatives retained per site; default 5, maximum 100.
- `exclude`: additional source exclusions. Tests, declaration files, generated-name patterns, `node_modules`, and `dist` are excluded by default. Files explicitly selected as contracts are never audited against themselves.

## Example

The synthetic example in `examples/basic/` produces:

```text
95/100 high   CreateWidgetResult → CreateWidgetResponse
80/100 high   ListWidgetsRequest → Omit<NonNullable<ListWidgetsData["query"]>, "customerId">
39/100 low    EmptyState → BannerRequest
```

The last match is deliberately a likely false positive: UI empty-state copy and an API banner request both contain `title` and `description`. Structural equality alone is not a reason to couple them.

## Confidence scoring

Scores rank review candidates. **They are not calibrated probabilities.** A score of 95 does not mean a 95% chance that replacing the type is correct.

The current model, `heuristic-v1`, adds:

- **+35** for an exact supported shape, or **+25** for a field subset.
- **+25** if the source file imports the exact resolved contract symbol. Same-name imports from another module do not qualify; named import aliases are followed.
- **+15** for meaningful declaration-name overlap.
- **+10** for meaningful overlap with imported names. This is lexical evidence, not data flow.
- **+5** for three matching fields, or **+10** for four or more.
- **+5** if only one resolved contract type matches in the configured search scope.

Multiple distinct targets subtract three points per additional target, up to 15. Equivalent aliases resolving to the same compiler type do not inflate that ambiguity count.

Scores without a resolved import or declaration-name overlap are capped at 39, or 59 if there is imported-name overlap. Two-field shapes without a resolved import are capped at 69. All scores are capped at 95.

- **High:** 75–95
- **Medium:** 50–74
- **Low:** below 50

Text, JSON, and Markdown include the score reasons. JSON also includes alternatives, locations, exclusions, diagnostics, and the confidence-model version. Changing contract scope can change ambiguity and scores.

## Comparison boundaries

The scanner examines named object type aliases, interfaces, and inline type literals, including function-local declarations. It compares resolved property types rather than source text or mutual assignability alone.

Supported comparisons preserve:

- Property names, optionality, and readonly modifiers.
- Primitive and string/number literal types, unions, and nullability.
- Arrays and array mutability.
- Supported nested object shapes.

Identical references to generated types can be kept as opaque leaves when expanding their internals is unsupported. For example, two fields already typed as the same generated `Widget[]` do not need every detail of `Widget` to be reimplemented by this tool.

Strict null checks must be enabled. Open or unsupported types are skipped, not guessed. The current implementation does not independently normalize generic declarations, mapped types, callable types, index signatures, tuples, recursive types, nominal classes, numeric-property shapes, or arbitrary intersections. Existing intersection-based derivations and interface extensions are not treated as copies.

Contract discovery covers exported top-level interfaces/type aliases and inline nested contract objects up to two levels. It does not discover every re-export-only barrel or verify that a suggested declaration is publicly exported by a package entrypoint. Namespace/default imports do not currently count as resolved import evidence.

The tool uses **TypeScript 5.9.2 bundled with ts-morph 27.0.2**, not your installed compiler. Source diagnostics are recorded, and affected declarations are skipped. Unsupported syntax, missing dependencies, skipped shapes, and limited contract scope can cause false negatives. A run with findings—or no findings—is not a clean application typecheck.

## Review workflow

1. Start with higher-scoring matches.
2. Confirm that the generated contract owns the data, rather than merely sharing its shape.
3. Check public exports, consumers, transformations, and optionality.
4. Prefer an existing generated type, or derive the intentionally smaller shape with `Pick`/`Omit`.
5. Run your application's checks after refactoring.

Findings and source diagnostics do not fail the process. Exit **0** means the audit completed. Invalid configuration or a failed scan exits **1**. There is no `--fix` or enforcement mode.

Analysis is local and performs no network requests or telemetry. Reports may contain source names, paths, and diagnostic messages; review them before sharing.

## Development

```sh
make install
make check
make demo
make pack
make smoke
```

`make check` checks JavaScript syntax and runs the regression suite. Tests cover comparison constraints, numeric keys, nested contracts, function-local declarations, symlinked SDKs, resolved imports, confidence, config validation, and CLI behavior. `make smoke` installs the packed archive into an ignored temporary directory and invokes its CLI.

The small modules under `src/` separate comparison, discovery, scoring, configuration, and reporting. Programmatic exports are experimental; the CLI and JSON report schema are the primary interface. When using the low-level comparator, read both shapes with the same reader and TypeScript project.
