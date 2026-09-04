# npm audit Network Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are not permitted for this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CI production dependency audit resilient to transient npm Registry network failures without masking vulnerability findings.

**Architecture:** Keep the existing `npm audit --omit=dev --audit-level=high` gate in `.github/workflows/ci.yml`. Capture each audit result, immediately fail non-network audit failures, and retry recognized advisory endpoint/network failures at most twice after the first attempt; return failure after the third failed attempt.

**Tech Stack:** GitHub Actions, Bash, npm CLI, Node.js 24.x.

## Global Constraints

- Use Node.js `>=24.0.0` as required by the repository.
- Keep `npm audit --omit=dev --audit-level=high` as a required security gate.
- Do not use `continue-on-error` for the security audit.
- Retry only advisory endpoint or recognized network errors.
- Limit the audit to three total attempts and set `--fetch-timeout=120000`.
- Do not add dependencies, secrets, credentials, or machine-specific paths.
- Do not add a repository test file for this workflow-only change.

---

### Task 1: Add bounded retry handling to the CI audit step

**Files:**
- Modify: `.github/workflows/ci.yml:29-30`
- Test: none; validate the workflow and run the shell simulation in Task 2.

**Interfaces:**
- Consumes: npm audit exit status and captured output from the production dependency tree.
- Produces: A CI step that exits `0` on a clean audit, exits immediately on a vulnerability failure, and retries recognized transient network failures at most three total attempts.

- [x] **Step 1: Replace the one-line audit command with the bounded shell loop**

Use this exact control flow in the existing `Security Audit (Production only)` step:

```bash
        for attempt in 1 2 3; do
          if output=$(npm audit --omit=dev --audit-level=high --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=120000 2>&1); then
            printf '%s\n' "$output"
            exit 0
          else
            status=$?
          fi
          printf '%s\n' "$output"

          case "$output" in
            *"audit endpoint returned an error"*|*"audit network timeout"*|*"ECONNRESET"*|*"ETIMEDOUT"*|*"EAI_AGAIN"*|*"ENETUNREACH"*|*"ENOTFOUND"*)
              ;;
            *)
              exit "$status"
              ;;
          esac

          if [ "$attempt" -lt 3 ]; then
            sleep "$((attempt * 10))"
          fi
        done
        exit "$status"
```

The command substitution must remain inside the `if` condition so the
workflow's `bash -e` does not terminate before the script classifies the
failure. The final `exit "$status"` must remain outside the loop so a
third-attempt network failure still fails the job.

- [x] **Step 2: Check the workflow syntax and diff**

Run:

```bash
actionlint .github/workflows/ci.yml
```

Expected: the workflow passes GitHub Actions syntax validation. Prettier's
repository-wide YAML formatting check is not used as a gate because the
pre-existing workflow formatting is not Prettier-normalized.

### Task 2: Verify the retry and failure behavior

**Files:**
- Verify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: The shell loop added in Task 1.
- Produces: Evidence that clean audits succeed, vulnerability failures do not retry, and transient network failures retry and eventually fail when exhausted.

- [x] **Step 1: Run a local shell simulation for all three outcomes**

Execute a temporary Bash simulation of the same `if output=$(...)`, status
capture, `case`, attempt counter, and final exit logic with a fake `npm`
function. Assert these outcomes:

1. Clean audit exits `0` on the first attempt.
2. Output containing `npm audit report` exits non-zero on the first attempt and does not retry.
3. Output containing `npm error audit endpoint returned an error` retries twice, then exits non-zero after the third attempt.

- [x] **Step 2: Run the existing production audit locally**

Run:

```bash
npm audit --omit=dev --audit-level=high --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=120000
```

Expected: exit `0` when the Registry is reachable and no high/critical
production vulnerability is present. In this verification run the command
reproduced the npm Registry advisory endpoint timeout seen in CI, so the
network-dependent audit result is recorded as an environmental limitation.

- [x] **Step 3: Run the repository lint and type checks**

Run:

```bash
npm run lint
npx tsc --noEmit
```

Expected: both commands pass; the workflow-only change does not affect
TypeScript compilation or linting.
