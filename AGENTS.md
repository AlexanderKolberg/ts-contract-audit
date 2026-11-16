# Working on ts-contract-audit

- Read README.md before changing matching, scoring, or CLI behavior.
- Keep the tool advisory. Confidence is an explainable heuristic, not a probability or approval to replace a type.
- Run validation through `make check`, `make demo`, and `make smoke`.
- Add regression fixtures for every comparison or scoring change. Prefer skipping unsupported shapes over false exact matches.
- Use synthetic fixtures only. Never commit consumer source, private paths, credentials, dependency configuration, or audit reports.
- Scratch files and packed artifacts belong in `tmp/`.
- Never modify a consumer's source. Report files must be explicitly requested and must not overwrite existing files.
- Keep analysis local. Do not add telemetry, network calls, automatic fixes, or enforcement without explicit approval.
- Keep one writer per checkout. Independent reviewers are read-only.
- Use Conventional Commits. Do not publish to npm without explicit approval.
