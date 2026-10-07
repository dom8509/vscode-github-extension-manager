# GitHub Extension Manager (BRAT for VS Code)

Install VS Code extensions straight from a GitHub repo, keep track of them, and update them when a new release is out — like BRAT does for Obsidian.

It uses the repo's **GitHub Releases**: the newest release must contain a `.vsix` file.

## Sidebar

Click the **GitHub Extensions** icon in the Activity Bar (left side). You see all tracked extensions:

- Green arrow = update available (`old tag → new tag`). The icon shows a badge with the number of updates.
- Warning sign = tracked, but not installed in this VS Code.
- Top buttons: install from URL, check for updates, update all, refresh.
- Per extension (hover or right-click): update, open releases, reinstall, stop tracking, uninstall.

## Commands (Cmd+Shift+P)

| Command | What it does |
|---|---|
| `GitHub Ext: Install from GitHub URL` | Paste `https://github.com/owner/repo` (or `owner/repo`). Downloads the `.vsix` from the latest release and installs it. |
| `GitHub Ext: Check for Updates` | Compares installed release tags with the newest release. Offers "Update All" / "Choose…". |
| `GitHub Ext: Update All` | Updates everything that has a newer release. |
| `GitHub Ext: List / Manage Tracked Extensions` | Shows tracked extensions. Per extension: update, reinstall, open repo, stop tracking, uninstall. |

Updates are also checked automatically ~8 s after VS Code starts (setting `ghext.checkOnStartup`).

## Settings

- `ghext.checkOnStartup` (default `true`) – check for updates on startup.
- `ghext.includePrereleases` (default `false`) – also take GitHub pre-releases.
- `ghext.githubToken` – optional personal access token. Needed for private repos and to avoid the 60 requests/hour API limit.

## Install this extension

```
code --install-extension github-extension-manager-0.1.0.vsix
```

## Build from source

```
npm install
npm run compile
npx @vscode/vsce package
```
