# Sonar Quality Gate Fixes Design

## Goal

Restore a passing SonarCloud quality gate for PR #274 without weakening Sonar
configuration or changing structured retrieval behavior.

## Scope

- Replace the benchmark's `Math.random()` temporary-directory suffix with
  `mkdtemp()`, which delegates uniqueness to the operating system.
- Extract the repeated structured-test setup into shared test helpers so the
  duplicate blocks reported by Sonar are removed while assertions and runtime
  behavior remain unchanged.
- Keep unrelated working-tree changes untouched.

## Design

The benchmark will create its temporary project directory with
`fs.mkdtemp(path.join(os.tmpdir(), prefix))` and retain its existing cleanup.
This removes the only new-code security issue without introducing a production
dependency or cryptographic randomness where it is not needed.

Structured retrieval tests will share only setup data and setup operations
that are identical across test files. Test-specific assertions and lifecycle
behavior remain in their original files. The helper API will use typed inputs
and existing in-memory stores, so the refactor does not change the production
surface.

## Verification

Run the affected Vitest files first, then the full Vitest suite, `npm run lint`,
`npx tsc --noEmit`, and `npm run build`. Confirm the resulting source contains
no benchmark `Math.random()` call and that the Sonar-reported duplicate regions
are no longer present in the changed test files.
