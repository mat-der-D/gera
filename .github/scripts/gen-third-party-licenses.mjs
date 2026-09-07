// gera 自身が取り込んでいる第三者コードの著作権表示を一つにまとめる。
//
// **MIT も BSD も Apache-2.0 も、著作権表示の同梱を求めている。**gera の
// 依存は GPL こそ無いが（npm 38・crate 400、いずれも MIT/Apache/BSD 系）、
// 「コピーレフトが無い」ことと「何も添えなくてよい」ことは別である。
//
// AppImage の同梱ライブラリの話（appimage-postprocess.sh）とは別物。
// あちらは **OS 側の共有ライブラリ**、こちらは **gera のバイナリと dist に
// 入っているコード**で、こちらは Windows・macOS・deb にも等しく効く。
//
//   node .github/scripts/gen-third-party-licenses.mjs
//
// で THIRD-PARTY-LICENSES.txt を作り直す。**中身は決定的である**——
// 同じロックファイルからは同じものが出る。CI はこれを回して、
// コミットされているものと食い違ったら落とす。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.join(repo, 'THIRD-PARTY-LICENSES.txt')

// **ライセンス本文を探す。**パッケージによって名前が違う（LICENSE、
// LICENSE-MIT、COPYING、NOTICE …）ので、拾えるものは全部拾って並べる。
const LICENCE_FILE = /^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)([-._].*)?$/i
function licenceTexts(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && LICENCE_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').trimEnd() }))
}

// ---------------------------------------------------------------------------
// npm 側
// ---------------------------------------------------------------------------
// **`dev` のものは外す。**devDependencies（vite、typescript、tauri-cli）は
// ビルドに使うだけで、配るものの中には入らない。判定はロックファイルの
// `dev` フラグに任せる——推移的な依存まで正しく付いている。
function npmPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'))
  const list = []
  for (const [key, v] of Object.entries(lock.packages)) {
    if (!key || v.dev || v.link) continue
    const dir = path.join(repo, key)
    const name = key.replace(/^.*node_modules\//, '')
    let declared = v.license
    if (!declared) {
      try {
        declared = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).license
      } catch { /* 下で UNKNOWN として落ちる */ }
    }
    list.push({ name, version: v.version, declared, dir })
  }
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// ---------------------------------------------------------------------------
// crate 側
// ---------------------------------------------------------------------------
// **配る4つのターゲットぶんを足し合わせる。**`cargo metadata` の解決結果を
// そのまま使うと、どのターゲットでも使わない crate まで入る（523 対 400）。
// 逆に一つのターゲットだけで採ると、他の OS 向けのぶんが落ちる。
const TARGETS = [
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]
function cargoPackages() {
  const tauri = path.join(repo, 'src-tauri')
  const used = new Set()
  for (const target of TARGETS) {
    const tree = execFileSync(
      'cargo',
      ['tree', '--target', target, '-e', 'normal,build', '--prefix', 'none', '--format', '{p}'],
      { cwd: tauri, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    for (const line of tree.split('\n')) {
      const m = line.trim().match(/^(\S+) v(\S+)/)
      if (m) used.add(`${m[1]} ${m[2]}`)
    }
  }

  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--all-features'], {
      cwd: tauri, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    }),
  )
  const list = []
  for (const p of meta.packages) {
    if (p.name === 'gera') continue
    if (!used.has(`${p.name} ${p.version}`)) continue
    list.push({
      name: p.name,
      version: p.version,
      declared: p.license,
      dir: path.dirname(p.manifest_path),
    })
  }
  return list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------
function section(title, packages, lines) {
  lines.push('', '='.repeat(80), title, '='.repeat(80))
  for (const p of packages) {
    // **条件が分からないものは落とす。**黙って配らない。
    if (!p.declared) throw new Error(`ライセンスが分からない: ${p.name} ${p.version} (${p.dir})`)
    lines.push('', '-'.repeat(80), `${p.name} ${p.version}`, `SPDX: ${p.declared}`, '-'.repeat(80))
    const texts = licenceTexts(p.dir)
    if (texts.length === 0) {
      // MIT や Apache-2.0 と名乗りながら本文を同梱していないものがある。
      // **勝手に本文を差し込まない**——どの著作権者の表示かを作れないので、
      // SPDX の識別子だけを残して、そう書いておく。
      lines.push('（このパッケージはライセンス本文を同梱していない。'
        + `条件は SPDX 識別子 ${p.declared} が指すもの。）`)
      continue
    }
    for (const t of texts) {
      if (texts.length > 1) lines.push(`--- ${t.name} ---`)
      lines.push(t.text)
    }
  }
}

const npm = npmPackages()
const crates = cargoPackages()
const lines = []
lines.push(
  '='.repeat(80),
  'gera — 取り込んでいる第三者コードの著作権表示',
  'gera — third-party copyright notices',
  '='.repeat(80),
  '',
  'gera 本体は MIT ライセンスである（同梱の LICENSE を見よ）。そのバイナリと',
  '画面側の資材には、下に挙げる第三者のコードが取り込まれている。**どれも',
  'MIT・Apache-2.0・BSD 系で、コピーレフトのものは無い**が、これらはいずれも',
  '著作権表示を添えることを求めているので、ここにまとめてある。',
  '',
  `npm パッケージ ${npm.length} 件、Rust の crate ${crates.length} 件。`,
  'crate は配る4つのターゲット（Linux x86_64／Windows x86_64／macOS arm64・x86_64）',
  'ぶんを足し合わせたもの。',
  '',
  '**AppImage には、これとは別に OS 側の共有ライブラリ（WebKitGTK・GTK3 など、',
  'LGPL）が同梱されている。**そちらの条件は同じ Release の',
  'THIRD-PARTY-LICENSES-linux.txt にある。',
  '',
  '-'.repeat(80),
  'gera itself is MIT-licensed (see LICENSE). Its binary and front-end assets',
  'incorporate the third-party code listed below. All of it is MIT, Apache-2.0',
  'or BSD-style — none is copyleft — but each requires its copyright notice to',
  'be reproduced, which is what this file is for.',
  '',
  `${npm.length} npm packages and ${crates.length} Rust crates, the latter being`,
  'the union over the four shipped targets.',
  '',
  'The Linux AppImage additionally bundles LGPL system libraries; see',
  'THIRD-PARTY-LICENSES-linux.txt in the same release.',
)
section(`npm パッケージ / npm packages (${npm.length})`, npm, lines)
section(`Rust crate / Rust crates (${crates.length})`, crates, lines)

const body = lines.join('\n') + '\n'
fs.writeFileSync(out, body)
console.log(
  `${path.relative(repo, out)} を書いた — npm ${npm.length} 件 / crate ${crates.length} 件、`
  + `${body.split('\n').length - 1} 行`,
)
