# Fork notes (Vstorion/dsh-pet)

## Layout

- `main` = mirror of upstream `PC2005-cloud/dsh-pet` `main` (tag v0.2.6). Never commit here.
- `local` = the working branch: upstream base + custom modifications. Installed via
  `github:Vstorion/dsh-pet#local`.
- `package.json` (root) = redirect manifest. The real plugin lives in `dsh-pet/`
  (upstream layout). The root manifest lets pnpm install this repo from git without
  a `&path:` fragment (the DSH CLI runs pnpm through cmd.exe on Windows, which
  splits arguments on `&`). Keep its version/peerDependencies/dependencies in sync
  with `dsh-pet/package.json` after upstream merges.

## Current custom modifications

- `feat(desktop): add hide-character context menu with system tray restore`
  - Right-click menu item "隐藏人物" hides the pet window without stopping DSH.
  - A system tray icon appears on first hide; click toggles show/hide.
  - Files: `dsh-pet/runtime/electron-helper/{main.js,preload.js,sprite.js}` +
    `tray-icon.png` / `tray-icon@2x.png`.

## Daily loop

```sh
git fetch upstream                          # get official updates
git checkout local
git merge upstream/main                     # resolve conflicts if any
cd dsh-pet && npm install                   # rebuild lib/ + shared-core.js (prepare)
git checkout -- dsh-pet/package-lock.json   # drop lockfile churn
git add -A && git commit -m "..."           # English commit messages
git push origin local
```

Then in the DSH profile (needs proxy for the git clone; profile allows builds via
`dangerouslyAllowAllBuilds` in its pnpm-workspace.yaml):

```sh
dsh plugin --profile web update dsh-pet     # re-resolves branch local
```

A DSH restart is required for the profile to reload the plugin.

## Install spec

`github:Vstorion/dsh-pet#local` — plain branch fragment, cmd.exe-safe.
