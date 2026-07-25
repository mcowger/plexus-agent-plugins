---
name: release
description: Bumps version, syncs across packages, commits, tags, and pushes a release using the local release script. TRIGGERS - release, bump version, publish release.
---

# Release Workflow

## When to Use This Skill

Use this skill when the user asks to "release", "bump version", "create a release", or "publish a new version". 
This skill will execute the project's built-in release script which automatically handles version synchronization, commits, tags, and pushing to the remote repository.

## Preconditions

```bash
git status --porcelain                 # 1. Ensure working tree is clean
git rev-parse --abbrev-ref HEAD        # 2. Ensure current branch is "main"
```

If the working tree is not clean, inform the user and abort. 
If the current branch is not `main`, inform the user and abort.

## Execution

The release process in this repository is fully automated by a local script.

```bash
bun scripts/release.ts <version>
```

Replace `<version>` with the semantic version number the user requested (e.g., `1.3.11`).

### What the script does:
1. Pulls the latest changes from `origin main`.
2. Syncs the specified `<version>` into all `package.json` files via `bun scripts/sync-versions.ts`.
3. Commits the changes with the message `Release v<version>`.
4. Creates an annotated tag `v<version>`.
5. Pushes the commit and the tag to `origin main`.

## Validation

Confirm the script executed successfully and the tag was pushed.

```bash
git log -1 --oneline                   # 1. Verify the release commit
git tag -l "v<version>"                # 2. Verify the tag exists locally
```

Inform the user that the release has been triggered and the CI/CD pipeline (e.g., GitHub Actions publish workflow) will take over.
