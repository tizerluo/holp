# strict-top-level-params summary

## Changed

- Added fail-closed top-level `orchestrate.run.params` allowlist validation at handler entry.
- Unknown top-level keys now return JSON-RPC `invalid_request` before a run is accepted.
- Top-level `model` / `env` mistakes include a corrective hint to use `roles.<role>.model` / `roles.<role>.env`.
- Added contract coverage for top-level `model`, `env`, and an arbitrary unknown key, plus a legal request using every allowed top-level field.
- Updated protocol docs/examples to remove the unsupported top-level `plan` example and document strict top-level rejection.

## Final Allowlist

- `goal`
- `trigger`
- `roles`
- `policy`
- `workflow`
- `max_steps`
- `planner`
- `execution_mode`

## Hard Gates

- `npm run typecheck`: 0 errors.
- `npm test`: 40 test files passed; 438 tests passed; 1 skipped; 439 total.

## Existing Test Cases Modified

None. New contract tests were added; no existing test expectations were changed.
