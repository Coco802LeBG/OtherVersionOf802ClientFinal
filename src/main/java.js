'use strict';
// Gestion de Java : runtime officiel Mojang (par défaut), détection du Java installé,
// ou téléchargement de Temurin (Adoptium) en secours.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { fetchJson, download, mapLimit, log } = require('./util');

const RUNTIME_ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const exeName = process.platform === 'win32' ? 'java.exe' : 'java';

function runtimeKey() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}

function javaExeIn(dir) {
  const cands = [
    path.join(dir, 'bin', exeName),
    path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', exeName),
    path.join(dir, 'Contents', 'Home', 'bin', exeName)
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

// ---------- Runtime officiel Mojang ----------
async function ensureMojangRuntime(paths, component, progress) {
  const key = runtimeKey();
  const all = await fetchJson(RUNTIME_ALL);
  const entry = all[key] && all[key][component] && all[key][component][0];
  if (!entry) throw new Error(`Runtime Java ${component} indisponible pour ${key}.`);

  const dir = path.join(paths.runtime, component, key);
  const okFile = path.join(dir, '.802-ok');
  const existing = javaExeIn(dir);
  try {
    if (existing && (await fsp.readFile(okFile, 'utf8')) === entry.version.name) return existing;
  } catch (_) { /* à (re)télécharger */ }

  progress({ step: 'java', pct: 0, text: `Téléchargement de Java (${component})…` });
  const manifestPath = path.join(dir, '.manifest.json');
  await download(entry.manifest.url, manifestPath, { algo: 'sha1', hash: entry.manifest.sha1 });
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  const files = Object.entries(manifest.files);
  for (const [rel, info] of files) {
    if (info.type === 'directory') await fsp.mkdir(path.join(dir, rel), { recursive: true });
  }
  const real = files.filter(([, i]) => i.type === 'file');
  let done = 0;
  await mapLimit(real, 12, async ([rel, info]) => {
    const dest = path.join(dir, rel);
    const raw = info.downloads.raw;
    await download(raw.url, dest, { algo: 'sha1', hash: raw.sha1 });
    if (info.executable && process.platform !== 'win32') await fsp.chmod(dest, 0o755);
    done++;
    if (done % 25 === 0 || done === real.length) {
      progress({ step: 'java', pct: Math.round((done / real.length) * 100), text: `Java ${done}/${real.length}` });
    }
  });
  if (process.platform !== 'win32') {
    for (const [rel, info] of files) {
      if (info.type === 'link') {
        const dest = path.join(dir, rel);
        try { await fsp.rm(dest, { force: true }); await fsp.symlink(info.target, dest); } catch (_) {}
      }
    }
  }
  await fsp.writeFile(okFile, entry.version.name);
  const exe = javaExeIn(dir);
  if (!exe) throw new Error('Java téléchargé mais introuvable.');
  return exe;
}

// ---------- Détection ----------
function probe(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stderr || ''}${stdout || ''}`;
      const m = out.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
      if (!m) return resolve(null);
      let major = parseInt(m[1], 10);
      if (major === 1 && m[2]) major = parseInt(m[2], 10);
      const vendor = /Temurin|Adoptium/i.test(out) ? 'Temurin' : /Microsoft/i.test(out) ? 'Microsoft' :
        /Zulu/i.test(out) ? 'Zulu' : /GraalVM/i.test(out) ? 'GraalVM' : 'OpenJDK/Oracle';
      resolve({ path: javaPath, major, vendor, label: `Java ${major} (${vendor})` });
    });
  });
}

async function detectJavas() {
  const cands = new Set();
  if (process.env.JAVA_HOME) cands.add(path.join(process.env.JAVA_HOME, 'bin', exeName));
  for (const p of (process.env.PATH || '').split(path.delimiter)) if (p) cands.add(path.join(p, exeName));
  const roots = [];
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Programs\\Eclipse Adoptium']) roots.push(path.join(base, v));
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm', path.join(os.homedir(), '.sdkman/candidates/java'));
  }
  for (const r of roots) {
    try {
      for (const d of await fsp.readdir(r)) {
        const exe = javaExeIn(path.join(r, d));
        if (exe) cands.add(exe);
      }
    } catch (_) {}
  }
  const found = [];
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    const info = await probe(c);
    if (info && !found.some((f) => f.path === info.path)) found.push(info);
  }
  return found.sort((a, b) => b.major - a.major);
}

// ---------- Temurin (Adoptium) ----------
async function downloadTemurin(paths, major, progress) {
  const osn = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${osn}&vendor=eclipse`;
  progress({ step: 'java', pct: 0, text: `Recherche de Temurin ${major}…` });
  const list = await fetchJson(api);
  const pkg = list[0] && list[0].binary && list[0].binary.package;
  if (!pkg) throw new Error(`Aucun Temurin ${major} disponible pour ${osn}/${arch}.`);

  const dir = path.join(paths.runtime, `temurin-${major}`);
  const existing = findJavaDeep(dir);
  if (existing) return existing;

  const archive = path.join(paths.runtime, pkg.name);
  progress({ step: 'java', pct: 10, text: `Téléchargement de ${pkg.name}…` });
  await download(pkg.link, archive, { algo: 'sha256', hash: pkg.checksum });
  await fsp.mkdir(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const args = pkg.name.endsWith('.zip') ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir];
    execFile('tar', args, { windowsHide: true }, (e) => (e ? reject(new Error('Extraction impossible : ' + e.message)) : resolve()));
  });
  await fsp.rm(archive, { force: true });
  const exe = findJavaDeep(dir);
  if (!exe) throw new Error('Temurin extrait mais java introuvable.');
  progress({ step: 'java', pct: 100, text: `Temurin ${major} prêt.` });
  return exe;
}
function findJavaDeep(dir, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, 'bin', exeName);
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findJavaDeep(path.join(dir, e.name), depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ---------- Choix final ----------
async function resolveJava(paths, profile, javaVersion, progress) {
  const need = (javaVersion && javaVersion.majorVersion) || 21;
  if (profile.javaPath) {
    const info = await probe(profile.javaPath);
    if (!info) throw new Error(`Java introuvable ou invalide : ${profile.javaPath}`);
    if (info.major < need) throw new Error(`${info.label} est trop ancien : Minecraft demande Java ${need} minimum.`);
    log(`Java choisi : ${info.label} (${profile.javaPath})`);
    return profile.javaPath;
  }
  try {
    const exe = await ensureMojangRuntime(paths, (javaVersion && javaVersion.component) || 'java-runtime-delta', progress);
    log(`Java officiel Mojang : ${exe}`);
    return exe;
  } catch (e) {
    log(`Runtime Mojang indisponible (${e.message}). Recherche d'un autre Java…`, 'warn');
  }
  const found = (await detectJavas()).find((j) => j.major >= need);
  if (found) { log(`Java détecté : ${found.label}`); return found.path; }
  log(`Téléchargement de Temurin ${need} (Adoptium)…`);
  return downloadTemurin(paths, need, progress);
}

module.exports = { resolveJava, detectJavas, downloadTemurin, ensureMojangRuntime, probe };
