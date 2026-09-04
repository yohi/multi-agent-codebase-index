# npm audit Network Retry Design

## Goal

Prevent transient npm Registry advisory endpoint failures from making the CI
job fail while keeping high-severity vulnerability findings as a hard failure.

## Design

The `Security Audit (Production only)` step in
`.github/workflows/ci.yml` will execute `npm audit --omit=dev` in a bounded
three-attempt loop. The step will retry only when npm reports an advisory
endpoint or known network failure. A vulnerability result will fail
immediately, and a network failure after the final attempt will preserve the
non-zero exit status.

Each npm request will have a 120-second timeout. Between network retries, the
step will wait 10 seconds and then 20 seconds. The audit remains a required
CI gate; `continue-on-error` will not be used.

## Verification

The workflow will be checked for YAML and GitHub Actions syntax. The retry
script will be exercised locally with simulated successful, vulnerability, and
transient-network outcomes. The existing production-only audit command will be
run locally when the npm Registry is reachable.

## Scope

Only `.github/workflows/ci.yml` and the accompanying design and implementation
records are changed. No dependency, application code, or security policy
changes are required.
