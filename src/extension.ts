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
let tree: TrackedTreeProvider;
let treeView: vscode.TreeView<TrackedItem>;
/** Latest known newer release per extId (filled by update checks). */
const pendingUpdates = new Map<string, Release>();

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
  for (const id of [...pendingUpdates.keys()]) {
    if (!t[id]) {
      pendingUpdates.delete(id);
    }
  }
  refreshView();
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
  pendingUpdates.delete(tracked.extId);
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
        pendingUpdates.set(t.extId, release);
      } else {
        pendingUpdates.delete(t.extId);
      }
    } catch (e: any) {
      errors.push(`${t.repo}: ${e?.message || e}`);
    }
  }));
  refreshView();
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

/* ---------- per-extension actions (used by tree view and quick pick) ---------- */

function showError(e: any): void {
  log(`ERROR: ${e?.message || e}`);
  vscode.window.showErrorMessage(`GitHub Ext: ${e?.message || e}`);
}

async function updateOne(t: Tracked): Promise<void> {
  const release = await fetchLatestRelease(parseRepoUrl(t.repo)!, cfg('includePrereleases', false), token());
  if (!release || compareVersions(release.tag_name, t.tag) <= 0) {
    pendingUpdates.delete(t.extId);
    refreshView();
    vscode.window.showInformationMessage(`${t.displayName} is up to date (${t.tag}).`);
  } else {
    await applyUpdates([{ tracked: t, release }]);
  }
}

async function reinstallOne(t: Tracked): Promise<void> {
  const ref = parseRepoUrl(t.repo)!;
  const release = await fetchLatestRelease(ref, cfg('includePrereleases', false), token());
  if (!release) {
    throw new Error('No release found.');
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitHub Ext: reinstalling ${t.displayName}` },
    p => installRelease(ref, release, p)
  );
  vscode.window.showInformationMessage(`Reinstalled ${t.displayName} ${release.tag_name}.`);
}

function openRepo(t: Tracked): void {
  vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${t.repo}/releases`));
}

async function untrackOne(t: Tracked): Promise<void> {
  const all = getTracked();
  delete all[t.extId];
  await setTracked(all);
  vscode.window.showInformationMessage(`${t.displayName} is no longer tracked.`);
}

async function uninstallOne(t: Tracked): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    `Uninstall ${t.displayName} and stop tracking it?`, { modal: true }, 'Uninstall'
  );
  if (ok !== 'Uninstall') {
    return;
  }
  await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', t.extId);
  const all = getTracked();
  delete all[t.extId];
  await setTracked(all);
  vscode.window.showInformationMessage(`${t.displayName} uninstalled.`);
}

/** Resolve the target of an item command: tree item if given, otherwise ask. */
async function resolveTarget(arg?: TrackedItem): Promise<Tracked | undefined> {
  if (arg?.tracked) {
    return getTracked()[arg.tracked.extId] ?? arg.tracked;
  }
  const items = Object.values(getTracked()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (items.length === 0) {
    vscode.window.showInformationMessage('GitHub Ext: nothing tracked yet.');
    return undefined;
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
  return pick?.t;
}

function itemCommand(fn: (t: Tracked) => unknown): (arg?: TrackedItem) => Promise<void> {
  return async arg => {
    const t = await resolveTarget(arg);
    if (!t) {
      return;
    }
    try {
      await fn(t);
    } catch (e: any) {
      showError(e);
    }
  };
}

async function cmdList(): Promise<void> {
  const t = await resolveTarget();
  if (!t) {
    return;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(sync) Check & update this one', fn: updateOne },
      { label: '$(cloud-download) Reinstall latest release', fn: reinstallOne },
      { label: '$(github) Open GitHub repo', fn: openRepo },
      { label: '$(eye-closed) Stop tracking (keep extension)', fn: untrackOne },
      { label: '$(trash) Uninstall extension & stop tracking', fn: uninstallOne }
    ],
    { placeHolder: t.displayName }
  );
  if (!action) {
    return;
  }
  try {
    await action.fn(t);
  } catch (e: any) {
    showError(e);
  }
}

/* ---------- sidebar tree view ---------- */

class TrackedItem extends vscode.TreeItem {
  constructor(public readonly tracked: Tracked) {
    super(tracked.displayName, vscode.TreeItemCollapsibleState.None);
    const update = pendingUpdates.get(tracked.extId);
    const installed = !!vscode.extensions.getExtension(tracked.extId);
    this.id = tracked.extId;
    this.description = update ? `${tracked.tag} → ${update.tag_name}` : tracked.tag;
    this.contextValue = update ? 'ghext.tracked.update' : 'ghext.tracked';
    if (update) {
      this.iconPath = new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.green'));
    } else if (!installed) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('extensions');
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${tracked.displayName}** \`${tracked.extId}\`\n\n`);
    md.appendMarkdown(`Version ${tracked.version} · release \`${tracked.tag}\`\n\n`);
    md.appendMarkdown(`Repo: [${tracked.repo}](https://github.com/${tracked.repo})\n\n`);
    md.appendMarkdown(`Installed ${new Date(tracked.installedAt).toLocaleString()}`);
    if (update) {
      md.appendMarkdown(`\n\n$(arrow-circle-up) Update available: [${update.tag_name}](${update.html_url})`);
    }
    if (!installed) {
      md.appendMarkdown(`\n\n$(warning) Not installed in this VS Code (or reload pending).`);
    }
    this.tooltip = md;
  }
}

class TrackedTreeProvider implements vscode.TreeDataProvider<TrackedItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }
  getTreeItem(item: TrackedItem): vscode.TreeItem {
    return item;
  }
  getChildren(): TrackedItem[] {
    return Object.values(getTracked())
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(t => new TrackedItem(t));
  }
}

function refreshView(): void {
  if (!tree) {
    return;
  }
  tree.refresh();
  const n = pendingUpdates.size;
  treeView.badge = n ? { value: n, tooltip: `${n} update(s) available` } : undefined;
  vscode.commands.executeCommand('setContext', 'ghext.hasUpdates', n > 0);
}

/* ---------- lifecycle ---------- */

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  out = vscode.window.createOutputChannel('GitHub Extension Manager');
  tree = new TrackedTreeProvider();
  treeView = vscode.window.createTreeView('ghext.trackedView', { treeDataProvider: tree, showCollapseAll: false });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('ghext.install', cmdInstall),
    vscode.commands.registerCommand('ghext.checkUpdates', () => cmdCheckUpdates(false)),
    vscode.commands.registerCommand('ghext.updateAll', cmdUpdateAll),
    vscode.commands.registerCommand('ghext.list', cmdList),
    vscode.commands.registerCommand('ghext.refresh', () => refreshView()),
    vscode.commands.registerCommand('ghext.item.update', itemCommand(updateOne)),
    vscode.commands.registerCommand('ghext.item.reinstall', itemCommand(reinstallOne)),
    vscode.commands.registerCommand('ghext.item.openRepo', itemCommand(openRepo)),
    vscode.commands.registerCommand('ghext.item.untrack', itemCommand(untrackOne)),
    vscode.commands.registerCommand('ghext.item.uninstall', itemCommand(uninstallOne)),
    vscode.extensions.onDidChange(() => refreshView())
  );
  refreshView();
  if (cfg('checkOnStartup', true)) {
    // small delay so startup is not slowed down
    setTimeout(() => cmdCheckUpdates(true).catch(e => log(`startup check failed: ${e}`)), 8000);
  }
}

export function deactivate(): void { /* nothing */ }
