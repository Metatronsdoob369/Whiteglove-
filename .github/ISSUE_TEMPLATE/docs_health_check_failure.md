---
name: Docs Health Check Failure
about: Track and resolve failures from the scheduled docs hygiene workflow
title: "Docs Health Check Failure"
labels: ["docs-health", "ci", "maintenance"]
assignees: []
---

## Summary

Automated docs health check failed and requires remediation before next release cycle.

## Run Context

- Workflow:
- Run URL:
- Branch:
- Commit SHA:
- Failure timestamp (UTC):

## Failed Checks

- [ ] SHA stamp consistency
- [ ] Marker scan (`TODO`/`WIP`/`legacy`/old SHA)
- [ ] Required artifact paths
- [ ] Local markdown link validation
- [ ] Other:

## Root Cause

<!-- Briefly describe what failed and why -->

## Remediation Plan

1.
2.
3.

## Verification

- [ ] `bash scripts/docs_release_check.sh --no-ci` passes locally
- [ ] PR opened with fix
- [ ] Required CI checks green

## Closure

- Closed by PR:
- Closed on (UTC):

