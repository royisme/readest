# Inkline Fork Branding Notes

Date: 2026-02-19

## Scope
This document records the fork branding baseline for renaming the app from `Readest` to `Inkline`.

## Updated Config
- Tauri app name and identifier
  - `productName`: `Inkline`
  - `mainBinaryName`: `inkline`
  - `identifier`: `com.royzhu.inkline`
- Desktop deep-link scheme
  - from `readest` to `inkline`
- Web/PWA display name
  - `manifest.json` and global layout metadata changed to `Inkline`
- Release script bundle names
  - iOS `.ipa` and macOS `.app/.pkg` switched to `Inkline`
- Associated app-link identifiers
  - Android `.well-known/assetlinks.json` package name switched to `com.royzhu.inkline`
  - iOS `.well-known/apple-app-site-association` bundle id switched to `com.royzhu.inkline`

## Validation Workflow
After these config edits, regenerate mobile projects:

```bash
pnpm --filter @readest/readest-app tauri android init --ci
pnpm --filter @readest/readest-app tauri ios init --ci
```

## Risks and Guardrails
- Risk: OAuth/deep-link callback mismatch after changing URI scheme.
  - Guardrail: ensure identity providers include `inkline://auth-callback`.
- Risk: Universal/App Links mismatch if domain ownership or team ID differs.
  - Guardrail: update `.well-known` files with your own team id, package id, and signing fingerprints.
- Risk: Updater still points to upstream endpoints.
  - Guardrail: replace updater `pubkey` and `endpoints` before shipping public builds.

## Rollback
To rollback quickly:
- Revert the branding commit.
- Re-run mobile project generation commands.

## Remaining Recommended Work
- Replace app icons with your own assets via:

```bash
pnpm --filter @readest/readest-app tauri icon ./src-tauri/app-icon.png
```

- Replace remaining user-visible `Readest` strings in UI/locales if you want full white-label output.
