# Runtime Session Matrix Notes

This note documents the PR12 vocabulary now visible in the consumer CLI matrix
report. It is descriptive only: scheduling decisions still belong to
`orchestrate.run` eligibility and isolation gates.

## Direct Channel Groups

`direct_user_session` declarations split capabilities into two groups:

- Observation surface: `attach`, `observe`, `read`, `owner_scope`.
- Control surface: `inject`, `interrupt`, `cancel`.

An observe-only session may honestly declare `attach/observe/read` as supported
while keeping `inject/interrupt/cancel` unknown or unsupported. That is useful
for dashboards and transcript readers, but it must not be treated as injectable
or cancellable scheduling readiness.

## Product Session Example

```json
{
  "runtime_surface": "direct_user_session",
  "runtime_kind": "product_session",
  "surface_support": "experimental",
  "direct_channel": {
    "channel_type": "product_session",
    "attach": "supported",
    "observe": "supported",
    "read": "supported",
    "inject": "unknown",
    "interrupt": "unknown",
    "cancel": "unknown",
    "owner_scope": "supported"
  },
  "isolation_profiles": {
    "read_only_review": {
      "readiness": "degraded",
      "reason": "observe_only",
      "warnings": ["declared_not_enforced"]
    }
  },
  "global_mutation_required": false,
  "declared_not_enforced": true
}
```

## Terminal Session Example

```json
{
  "runtime_surface": "direct_user_session",
  "runtime_kind": "tmux",
  "surface_support": "experimental",
  "direct_channel": {
    "channel_type": "tmux",
    "attach": "supported",
    "observe": "supported",
    "read": "supported",
    "inject": "unsupported",
    "interrupt": "unsupported",
    "cancel": "unsupported",
    "owner_scope": "unknown"
  },
  "isolation_profiles": {
    "read_only_review": {
      "readiness": "rejected",
      "reason": "owner_scope_not_declared",
      "missing": ["owner_scope"]
    }
  },
  "global_mutation_required": false,
  "declared_not_enforced": true
}
```

## cmux / Warp / tmux Boundary

PR12 does not claim a real cmux, Warp, or tmux adapter. Real ACP/direct paths
belong to Blueprint M8; stable consumer/gate rendering belongs to Blueprint M9.
A future adapter SPEC must cite the exact public documentation, local source
path, version, or commit that defines its event model before mapping it to HOLP
`events.subscribe`. Unknown fields must stay `unknown` or `rejected`; the matrix
report must not invent attach, observe, inject, interrupt, or cancel behavior.

PR14 later proved a first-batch harness pilot, not complete runtime-surface
parity and not cmux readiness. Issue #45 tracks the bounded CLI cohort plus
terminal-consumer smoke phase required before #41 can claim learned-router data
sufficiency. The final #45 validation result lives in
`docs/runtime-surface-validation-matrix.md`; this PR12 note remains the
vocabulary/background reference.
