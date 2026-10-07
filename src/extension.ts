import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseRepoUrl, fetchLatestRelease, vsixAssets, pickAsset, downloadAsset,
  readVsixManifest, compareVersions, Release, ReleaseAsset, RepoRef
} from './github';

const STATE_KEY = 'ghext.tracked';

interface Tracked {
  extId: string;          // publisher.name (lowercase)
  displayName: string;
  repo: string;           // owner/repo
  tag: string;            // release tag installed
  version: string;        // version from package.json inside vsix
  assetName: string;
  installedAt: string;
}

interface UpdateInfo {
  tracked: Tracked;
  release: Release;
}

let ctx: vscode.ExtensionContext;
let out: vscode.OutputChannel;

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('ghext').get<T>(key, def);
}
function token(): string | undefined {
  const t = cfg<string>('githubToken', '');
  return t ? t : undefined;
}
function getTracked(): Record<string, Tracked> {
  return ctx.globalState.get<Record<string, Tracked>>(STATE_KEY, {});
}
async function setTracked(t: Record<string, Tracked>): Promise<void> {
  await ctx.globalState.update(STATE_KEY, t);
}
function log(msg: string): void {
  out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/* ---------- core: install/update one release ---------- */

async function installRelease(ref: RepoRef, release: Release, progress?: vscode.Progress<{ message?: string }>): Promise<Tracked> {
  const assets = vsixAssets(release);
  if (assets.length === 0) {
    throw new Error(`Release ${release.tag_name} of ${ref.owner}/${ref.repo} has no .vsix asset.`);
  }
  let asset: ReleaseAsset | undefined = pickAsset(assets);
  if (!asset) {
    const pick = await vscode.window.showQuickPick(
      assets.map(a => ({ label: a.name, description: `${(a.size / 1024 / 1024).toFixed(1)} MB`, asset: a })),
      { placeHolder: 'Several .vsix files found – which one fits your machine?' }
    );
    if (!pick) {
      throw new Error('Cancelled');
    }
    asset = pick.asset;
  }

  progress?.report({ message: `Downloading ${asset.name}…` });
  log(`Downloading ${asset.browser_download_url}`);
  const file = await downloadAsset(asset, token());

  const manifest = readVsixManifest(file);
  progress?.report({ message: `Installing ${manifest.displayName || manifest.id} ${manifest.version}…` });
  log(`Installing ${manifest.id}@${manifest.version} from ${file}`);
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));

  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch { /* ignore */ }

  const tracked: Tracked = {
    extId: manifest.id,
    displayName: manifest.displayName || manifest.id,
    repo: `${ref.owner}/${ref.repo}`,
    tag: release.tag_name,
    version: manifest.version,
    assetName: asset.name,
    installedAt: new Date().toISOString()
  };
  const all = getTracked();
  all[tracked.extId] = tracked;
  await setTracked(all);
  return tracked;
}

/* ---------- commands ---------- */

async function cmdInstall(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: 'GitHub repo of the extension',
    placeHolder: 'https://github.com/owner/repo  or  owner/repo',
    ignoreFocusOut: true
  });
  if (!input) {
    return;
  }
  const ref = parseRepoUrl(input);
  if (!ref) {
    vscode.window.showErrorMessage('That does not look like a GitHub repo URL.');
    return;
  }
  try {
    const tracked = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitHub Ext: ${ref.owner}/${ref.repo}`, cancellable: false },
      async progress => {
        progress.report({ message: 'Looking up latest release…' });
        const release = await fetchLatestRelease(ref, cfg('includePrereleases', false), token());
        if (!release) {
          throw new Error(`No releases found for ${ref.owner}/${ref.repo}.`);
        }
        return installRelease(ref, release, progress);
      }
    );
    vscode.window.showInformationMessage(`Installed ${tracked.displayName} ${tracked.version} (${tracked.tag}). Now tracked for updates.`);
  } catch (e: any) {
    if (e?.message !== 'Cancelled') {
      log(`ERROR: ${e?.message || e}`);
      vscode.window.showErrorMessage(`GitHub Ext: ${e?.message || e}`);
    }
  }
}

async function findUpdates(): Promise<{ updates: UpdateInfo[]; errors: string[] }> {
  const tracked = Object.values(getTracked());
  const updates: UpdateInfo[] = [];
  const errors: string[] = [];
  await Promise.all(tracked.map(async t => {
    const ref = parseRepoUrl(t.repo)!;
    try {
      const release = await fetchLatestRelease(ref, cfg('includePrereleases', false), token());
      if (release && release.tag_name !== t.tag && compareVersions(release.tag_name, t.tag) > 0) {
        updates.push({ tracked: t, release });
      }
    } catch (e: any) {
      errors.push(`${t.repo}: ${e?.message || e}`);
    }
  }));
  return { updates, errors };
}

async function applyUpdates(updates: UpdateInfo[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  const done: string[] = [];
  const failed: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitHub Ext: updating', cancellable: false },
    async progress => {
      for (const u of updates) {
        try {
          progress.report({ message: `${u.tracked.displayName} → ${u.release.tag_name}` });
          await installRelease(parseRepoUrl(u.tracked.repo)!, u.release, progress);
          done.push(`${u.tracked.displayName} ${u.release.tag_name}`);
        } catch (e: any) {
          log(`ERROR updating ${u.tracked.repo}: ${e?.message || e}`);
          failed.push(`${u.tracked.displayName}: ${e?.message || e}`);
        }
      }
    }
  );
  if (done.length) {
    const r = await vscode.window.showInformationMessage(`Updated: ${done.join(', ')}. Reload to activate.`, 'Reload Window');
    if (r) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
  if (failed.length) {
    vscode.window.showErrorMessage(`Update failed – ${failed.join('; ')}`);
  }
}

async function cmdCheckUpdates(silentIfNone: boolean): Promise<void> {
  const tracked = getTracked();
  if (Object.keys(tracked).length === 0) {
    if (!silentIfNone) {
      vscode.window.showInformationMessage('GitHub Ext: nothing tracked yet. Run "GitHub Ext: Install from GitHub URL" first.');
    }
    return;
  }
  const { updates, errors } = await findUpdates();
  errors.forEach(e => log(`check error: ${e}`));
  if (updates.length === 0) {
    if (!silentIfNone) {
      vscode.window.showInformationMessage(
        errors.length ? `GitHub Ext: no updates (${errors.length} repo(s) could not be checked – see Output).` : 'GitHub Ext: everything is up to date.'
      );
    }
    return;
  }
  const names = updates.map(u => `${u.tracked.displayName} ${u.tracked.tag} → ${u.release.tag_name}`).join(', ');
  const choice = await vscode.window.showInformationMessage(
    `GitHub Ext: ${updates.length} update(s) available: ${names}`,
    'Update All', 'Choose…', 'Later'
  );
  if (choice === 'Update All') {
    await applyUpdates(updates);
  } else if (choice === 'Choose…') {
    const picks = await vscode.window.showQuickPick(
      updates.map(u => ({ label: u.tracked.displayName, description: `${u.tracked.tag} → ${u.release.tag_name}`, detail: u.release.html_url, picked: true, u })),
      { canPickMany: true, placeHolder: 'Select extensions to update' }
    );
    if (picks?.length) {
      await applyUpdates(picks.map(p => p.u));
    }
  }
}

async function cmdUpdateAll(): Promise<void> {
  const { updates, errors } = await findUpdates();
  errors.forEach(e => log(`check error: ${e}`));
  if (updates.length === 0) {
    vscode.window.showInformationMessage('GitHub Ext: everything is up to date.');
    return;
  }
  await applyUpdates(updates);
}

async function cmdList(): Promise<void> {
  const all = getTracked();
  const items = Object.values(all).sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (items.length === 0) {
    vscode.window.showInformationMessage('GitHub Ext: nothing tracked yet.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    items.map(t => ({
      label: t.displayName,
      description: `${t.version} (${t.tag})`,
      detail: `${t.repo} · ${t.extId} · installed ${new Date(t.installedAt).toLocaleDateString()}`,
      t
    })),
    { placeHolder: 'Tracked extensions – pick one to manage' }
  );
  if (!pick) {
    return;
  }
  const t = pick.t;
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(sync) Check & update this one', id: 'update' },
      { label: '$(cloud-download) Reinstall latest release', id: 'reinstall' },
      { label: '$(github) Open GitHub repo', id: 'open' },
      { label: '$(eye-closed) Stop tracking (keep extension)', id: 'untrack' },
      { label: '$(trash) Uninstall extension & stop tracking', id: 'uninstall' }
    ],
    { placeHolder: t.displayName }
  );
  if (!action) {
    return;
  }
  const ref = parseRepoUrl(t.repo)!;
  try {
    switch (action.id) {
      case 'update': {
        const release = await fetchLatestRelease(ref, cfg('includePrereleases', false), token());
        if (!release || compareVersions(release.tag_name, t.tag) <= 0) {
          vscode.window.showInformationMessage(`${t.displayName} is up to date (${t.tag}).`);
        } else {
          await applyUpdates([{ tracked: t, release }]);
        }
        break;
      }
      case 'reinstall': {
        const release = await fetchLatestRelease(ref, cfg('includePrereleases', false), token());
        if (!release) {
          throw new Error('No release found.');
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `GitHub Ext: reinstalling ${t.displayName}` },
          p => installRelease(ref, release, p)
        );
        vscode.window.showInformationMessage(`Reinstalled ${t.displayName} ${release.tag_name}.`);
        break;
      }
      case 'open':
        vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${t.repo}/releases`));
        break;
      case 'untrack':
        delete all[t.extId];
        await setTracked(all);
        vscode.window.showInformationMessage(`${t.displayName} is no longer tracked.`);
        break;
      case 'uninstall':
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', t.extId);
        delete all[t.extId];
        await setTracked(all);
        vscode.window.showInformationMessage(`${t.displayName} uninstalled.`);
        break;
    }
  } catch (e: any) {
    log(`ERROR: ${e?.message || e}`);
    vscode.window.showErrorMessage(`GitHub Ext: ${e?.message || e}`);
  }
}

/* ---------- lifecycle ---------- */

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('GitHub Extension Manager');
  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('ghext.install', cmdInstall),
    vscode.commands.registerCommand('ghext.checkUpdates', () => cmdCheckUpdates(false)),
    vscode.commands.registerCommand('ghext.updateAll', cmdUpdateAll),
    vscode.commands.registerCommand('ghext.list', cmdList)
  );
  if (cfg('checkOnStartup', true)) {
    // small delay so startup is not slowed down
    setTimeout(() => cmdCheckUpdates(true).catch(e => log(`startup check failed: ${e}`)), 8000);
  }
}

export function deactivate(): void { /* nothing */ }
