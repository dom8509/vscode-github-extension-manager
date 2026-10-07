/**
 * Pure Node helpers: GitHub API, download, minimal .vsix (zip) reader.
 * No vscode import here so it can be unit-tested outside VS Code.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  html_url: string;
  assets: ReleaseAsset[];
}

/** Accepts "owner/repo", "https://github.com/owner/repo", ".git" suffix, deep links. */
export function parseRepoUrl(input: string): RepoRef | undefined {
  const s = input.trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i);
  if (!m) {
    m = s.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+)/i);
  }
  if (!m) {
    m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  }
  if (!m) {
    return undefined;
  }
  const repo = m[2].replace(/\.git$/i, '');
  return { owner: m[1], repo };
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'vscode-github-extension-manager',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
  }
  return h;
}

/** Newest non-draft release (optionally including pre-releases). */
export async function fetchLatestRelease(
  ref: RepoRef,
  includePrereleases: boolean,
  token?: string
): Promise<Release | undefined> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/releases?per_page=30`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) {
    throw new Error(`Repo ${ref.owner}/${ref.repo} not found (or private without token).`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API rate limit hit. Set a token in setting "ghext.githubToken".');
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${ref.owner}/${ref.repo}`);
  }
  const releases = (await res.json()) as Release[];
  return releases.find(r => !r.draft && (includePrereleases || !r.prerelease));
}

export function vsixAssets(release: Release): ReleaseAsset[] {
  return release.assets.filter(a => a.name.toLowerCase().endsWith('.vsix'));
}

/** Current platform target in VS Code naming, e.g. "darwin-arm64". */
export function platformTarget(): string {
  const p = os.platform(); // darwin | win32 | linux
  const a = os.arch();     // arm64 | x64 | arm
  const plat = p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux';
  return `${plat}-${a}`;
}

const KNOWN_TARGETS = [
  'win32-x64', 'win32-arm64', 'win32-ia32',
  'linux-x64', 'linux-arm64', 'linux-armhf',
  'alpine-x64', 'alpine-arm64',
  'darwin-x64', 'darwin-arm64',
  'web'
];

/**
 * Pick the best asset automatically:
 *  - exactly one .vsix -> that one
 *  - one matching the current platform -> that one
 *  - one "universal" (no platform suffix) -> that one
 *  - otherwise undefined (caller should ask the user)
 */
export function pickAsset(assets: ReleaseAsset[], target: string = platformTarget()): ReleaseAsset | undefined {
  if (assets.length === 0) {
    return undefined;
  }
  if (assets.length === 1) {
    return assets[0];
  }
  const byPlatform = assets.find(a => a.name.toLowerCase().includes(target));
  if (byPlatform) {
    return byPlatform;
  }
  const universal = assets.filter(a => !KNOWN_TARGETS.some(t => a.name.toLowerCase().includes(t)));
  if (universal.length === 1) {
    return universal[0];
  }
  return undefined;
}

export async function downloadAsset(
  asset: ReleaseAsset,
  token?: string,
  onProgress?: (received: number, total: number) => void
): Promise<string> {
  const h = headers(token);
  h['Accept'] = 'application/octet-stream';
  const res = await fetch(asset.browser_download_url, { headers: h, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) for ${asset.name}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghext-'));
  const file = path.join(dir, asset.name);
  const total = asset.size || Number(res.headers.get('content-length') || 0);
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = res.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
    received += value.length;
    onProgress?.(received, total);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

/* ---------- version comparison ---------- */

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v(?=\d)/i, '');
}

/** Returns >0 if a is newer than b, <0 if older, 0 if equal. Semver-ish, tolerant. */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.\-+]/);
  const pb = normalizeVersion(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) {
      // "1.2.0" vs "1.2.0-beta": the one WITH a suffix is older
      return /^\d+$/.test(y) ? -1 : 1;
    }
    if (y === undefined) {
      return /^\d+$/.test(x) ? 1 : -1;
    }
    const nx = Number(x);
    const ny = Number(y);
    const bothNum = !isNaN(nx) && !isNaN(ny) && /^\d+$/.test(x) && /^\d+$/.test(y);
    if (bothNum) {
      if (nx !== ny) {
        return nx > ny ? 1 : -1;
      }
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/* ---------- minimal zip reader (just enough to read extension/package.json) ---------- */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // find End Of Central Directory record (0x06054b50), scanning back max 64k+22
  const minPos = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a valid .vsix/zip file');
  }
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      break;
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localHeaderOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error('Bad local header in zip');
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) {
    return Buffer.from(data);
  }
  if (e.method === 8) {
    return zlib.inflateRawSync(data);
  }
  throw new Error(`Unsupported zip compression method ${e.method}`);
}

export interface VsixManifest {
  publisher: string;
  name: string;
  version: string;
  displayName?: string;
  id: string; // publisher.name (lowercase)
}

/** Reads extension/package.json from a .vsix without external deps. */
export function readVsixManifest(vsixPath: string): VsixManifest {
  const buf = fs.readFileSync(vsixPath);
  const entries = readCentralDirectory(buf);
  const entry = entries.find(e => e.name === 'extension/package.json');
  if (!entry) {
    throw new Error('extension/package.json not found inside .vsix');
  }
  const pkg = JSON.parse(readEntry(buf, entry).toString('utf8'));
  const publisher = String(pkg.publisher || '');
  const name = String(pkg.name || '');
  return {
    publisher,
    name,
    version: String(pkg.version || '0.0.0'),
    displayName: pkg.displayName,
    id: `${publisher}.${name}`.toLowerCase()
  };
}
