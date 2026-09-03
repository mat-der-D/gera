import { defineConfig, type Plugin } from "vite"

/**
 * KaTeX は 20 の書体それぞれに woff2 / woff / ttf の 3 形式を持つ。
 * 実際に読まれるのは woff2 だけで（WebKitGTK・WebView2・WKWebView は
 * いずれも woff2 に対応する）、woff と ttf は一度も要求されないまま
 * 約 817KB を成果物に積む。バイナリは丸ごと Tauri に埋め込まれ、
 * コールド起動の読み込み量になるので落とす（設計 第 4 節・第 5-1 節）。
 *
 * 落とすのはファイルだけでなく、CSS の @font-face から
 * 対応する src エントリも消す。残すと存在しない URL への参照が残る。
 */
function dropNonWoff2Fonts(): Plugin {
  const fallbackSrc = /,url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g
  return {
    name: "gera-drop-non-woff2-fonts",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (/\.(?:woff|ttf)$/.test(fileName)) {
          delete bundle[fileName]
          continue
        }
        if (chunk.type === "asset" && fileName.endsWith(".css") && typeof chunk.source === "string") {
          chunk.source = chunk.source.replace(fallbackSrc, "")
        }
      }
    },
  }
}

// Tauri が固定ポートを前提にするため、ポートは固定し、衝突時は失敗させる。
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // sourcemap を出すと dist に約 3.6MB の .map が乗り、Tauri がそれごと
  // バイナリに埋め込む。リリースビルドでは devtools を開けないため
  // 使われることがなく、起動時の読み込み量だけが増える。
  build: { target: "es2022", sourcemap: false },
  plugins: [dropNonWoff2Fonts()],
})
