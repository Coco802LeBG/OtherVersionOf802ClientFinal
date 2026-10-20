'use strict';
// Test du moteur sans réseau : règles Mojang, arguments de lancement, hash, chemins maven.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mc = require('../src/main/minecraft');
const util = require('../src/main/util');
const { makePaths } = require('../src/main/paths');
const auth = require('../src/main/auth');

// 1. Règles
const winOnly = [{ action: 'allow', os: { name: 'windows' } }];
assert.strictEqual(mc.rulesAllow(winOnly), process.platform === 'win32');
assert.strictEqual(mc.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }]), process.platform !== 'win32');
assert.strictEqual(mc.rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }), true);
assert.strictEqual(mc.rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], {}), false);
assert.strictEqual(mc.rulesAllow(undefined), true);

// 2. Maven
assert.strictEqual(util.mavenPath('net.fabricmc:fabric-loader:0.19.5'), 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
assert.strictEqual(util.mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');

// 3. Arguments
assert.deepStrictEqual(util.splitArgs('-Xa "-Db=c d" -Dz'), ['-Xa', '-Db=c d', '-Dz']);

// 4. Commande complète avec un faux version.json
const root = fs.mkdtempSync(path.join(os.tmpdir(), '802-'));
const paths = makePaths(root);
const vanilla = {
  assetIndex: { id: '99' },
  libraries: [
    { name: 'com.example:a:1.0', downloads: { artifact: { path: 'com/example/a/1.0/a-1.0.jar', url: 'x', sha1: 'y' } } },
    { name: 'com.example:onlymac:1.0', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'm.jar', url: 'x', sha1: 'y' } } }
  ],
  arguments: {
    jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--accessToken', '${auth_access_token}',
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }]
  }
};
const fabric = { id: 'fabric-loader-0.19.5-1.21.11', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] }, libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', path: 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar' }] };
const profile = { ramMin: 1024, ramMax: 4096, jvmArgs: '-XX:+UseG1GC', width: 1280, height: 720, fullscreen: false };
const account = auth.offlineAccount('Tester');
const cmd = mc.buildCommand({ vanilla, logArg: '-Dlog4j.x=1', fabric, paths, profile, account, javaPath: 'java', gameDir: path.join(root, 'game'), mcVersion: '1.21.11', launcherVersion: '1.0.0' });
const a = cmd.args;
assert.ok(a.includes('-Xmx4096M') && a.includes('-Xms1024M') && a.includes('-XX:+UseG1GC'));
assert.ok(a.indexOf('net.fabricmc.loader.impl.launch.knot.KnotClient') > a.indexOf('-cp'));
assert.ok(a.includes('--width') && a.includes('1280'));
assert.ok(a[a.indexOf('--username') + 1] === 'Tester');
const cp = a[a.indexOf('-cp') + 1];
assert.ok(cp.includes('a-1.0.jar') && cp.includes('fabric-loader-0.19.5.jar') && cp.endsWith('1.21.11.jar'));
assert.ok(process.platform === 'darwin' || !cp.includes('m.jar'));
assert.ok(!a.some((x) => x.includes('${')), 'variable non remplacée : ' + a.find((x) => x.includes('${')));
const full = mc.buildCommand({ vanilla, logArg: null, fabric, paths, profile: { ...profile, fullscreen: true }, account, javaPath: 'java', gameDir: root, mcVersion: '1.21.11', launcherVersion: '1' });
assert.ok(full.args.includes('--fullscreen') && !full.args.includes('--width'));

// 5. Hash + téléchargement local (file://) non supporté : on teste juste hashFile
const f = path.join(root, 'h.txt'); fs.writeFileSync(f, 'abc');
util.hashFile(f, 'sha1').then((h) => {
  assert.strictEqual(h, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  console.log('Tous les tests du moteur sont OK.');
});
