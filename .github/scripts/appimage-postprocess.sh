#!/usr/bin/env bash
#
# AppImage の後始末。**`tauri build --bundles appimage` のあとに走らせる。**
#
# **deb と AppImage では、ライセンスの立場がまるで違う。**deb は
# `Depends: libwebkit2gtk-4.1-0, libgtk-3-0` と書くだけで、共有ライブラリを
# 一つも再配布しない。AppImage は同梱する。**同梱したものの条件が、そのまま
# gera の配布条件になる。**
#
# gera 自身の依存（npm 60・crate 523）には GPL は無い。問題は
# linuxdeploy-plugin-gtk が「GTK まわり一式」として入れてくるもののほうで、
# gera が呼びもしない経路から GPL のライブラリが二本ぶら下がってくる。
# ここではそれを落として、残ったものの条件を書き出し、詰め直す。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
bundle="$repo/src-tauri/target/release/bundle/appimage"
appdir="$bundle/gera.AppDir"
recorded="$here/appimage-bundled-packages.txt"
notice_name="THIRD-PARTY-LICENSES.txt"

[ -d "$appdir" ] || { echo "AppDir が無い: $appdir" >&2; exit 1; }

# 元の AppImage の名前を控える。詰め直したものに同じ名前を付ける。
appimage=$(find "$bundle" -maxdepth 1 -name '*.AppImage' -printf '%f\n' | head -1)
[ -n "$appimage" ] || { echo "元の .AppImage が見つからない" >&2; exit 1; }
echo "対象: $appimage"

# ---------------------------------------------------------------------------
# 1. GPL の経路を落とす
# ---------------------------------------------------------------------------
# **(a) TIFF ローダー → libtiff → libjbig。**libjbig（jbigkit）は **GPL-2+
# 単独**である。libtiff 自体は Hylafax ライセンス（BSD 系）だが `NEEDED` に
# libjbig を持つので、libjbig だけ抜くと libtiff が読み込めなくなる。
# libtiff を必要とするのは gdk-pixbuf の TIFF ローダー一つだけで、
# **gera は TIFF を扱わない。**だから経路ごと落とす。
#
# **(b) canberra → libltdl。**libltdl の Debian の copyright は
# `Files: *` に **GPL-2+** と書いてある（上流の libltdl/ は LGPL だが、
# Debian のこのファイルはそこを分けていない）。libltdl を引くのは
# libcanberra——GTK の効果音ライブラリ——だけで、**gera は音を鳴らさない。**
# 条件の解釈で揉めるより、使っていない経路を落とすほうが速い。
#
# 落としてよいことは「他に `NEEDED` しているものが無い」で確かめてある。
# 下の検査で、消し漏れと参照残りの両方を見る。
loaders_dir="$appdir/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders"
loaders_cache="$appdir/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders.cache"
gtk_modules="$appdir/usr/lib/x86_64-linux-gnu/gtk-3.0/modules"

rm -fv "$appdir/usr/lib/libjbig.so.0" \
       "$appdir/usr/lib/libtiff.so.6" \
       "$appdir/usr/lib/libpixbufloader-tiff.so" \
       "$loaders_dir/libpixbufloader-tiff.so" \
       "$appdir/usr/lib/libltdl.so.7" \
       "$appdir/usr/lib/libcanberra.so.0" \
       "$appdir/usr/lib/libcanberra-gtk3.so.0" \
       "$gtk_modules/libcanberra-gtk-module.so" \
       "$gtk_modules/libcanberra-gtk3-module.so"

# **loaders.cache からも消す。**残すと gdk-pixbuf が
# 「モジュールが開けない」を吐く。1行目が `"モジュール名"` で、そこから
# 空行までが一つの塊になっている書式なので、塊ごと落とす。
if [ -f "$loaders_cache" ]; then
  awk '
    /^"libpixbufloader-tiff\.so"$/ { skip = 1 }
    skip && /^$/                   { skip = 0; next }
    !skip
  ' "$loaders_cache" > "$loaders_cache.new"
  mv "$loaders_cache.new" "$loaders_cache"
  if grep -q 'libpixbufloader-tiff' "$loaders_cache"; then
    echo "loaders.cache から TIFF の塊を落とせていない" >&2; exit 1
  fi
fi

# **消したものを、まだ誰かが必要としていないか。**ここを黙って通すと、
# 起動しない AppImage を配ることになる。
dangling=$(find "$appdir" -type f -name '*.so*' -print0 \
  | xargs -0 -r -n1 sh -c 'objdump -p "$1" 2>/dev/null \
      | grep -qE "NEEDED.*(libtiff|libjbig|libltdl|libcanberra)" && echo "$1"' _ || true)
if [ -n "$dangling" ]; then
  echo "落としたライブラリを、まだ必要としているものが残っている:" >&2
  echo "$dangling" >&2
  exit 1
fi

# **実体の消し残しも見る。**シンボリックリンクだけ消えて本体が
# 残っていると、パッケージ一覧のほうに GPL のものが並んだままになる。
leftover=$(find "$appdir" \( -name 'libjbig*' -o -name 'libtiff*' \
        -o -name 'libltdl*' -o -name '*canberra*' \) -print)
if [ -n "$leftover" ]; then
  echo "落としたはずのものが残っている:" >&2; echo "$leftover" >&2; exit 1
fi
echo "GPL の経路を落とした（libjbig / libtiff / libltdl / libcanberra）"

# ---------------------------------------------------------------------------
# 2. 同梱物を数え上げ、記録と突き合わせる
# ---------------------------------------------------------------------------
# AppDir の中のライブラリは、組んだ機械の `/usr/lib/x86_64-linux-gnu/` からの
# 複製である。`usr/lib/` 直下に平らに置かれたものも、
# `usr/lib/x86_64-linux-gnu/...` の下のものも、同じ相対位置に元がある。
# そこから `dpkg -S` で提供元のパッケージを引く。
actual=$(mktemp)
find "$appdir/usr/lib" -type f -name '*.so*' | while read -r f; do
  rel=${f#"$appdir/usr/lib/"}
  case "$rel" in
    x86_64-linux-gnu/*) sys="/usr/lib/$rel" ;;
    *)                  sys="/usr/lib/x86_64-linux-gnu/$rel" ;;
  esac
  pkg=$(dpkg -S "$sys" 2>/dev/null | head -1 | cut -d: -f1)
  # **引けなかったら落とす。**条件の分からないものを黙って同梱しない。
  [ -n "$pkg" ] || { echo "提供元のパッケージを引けない: $f" >&2; exit 1; }
  echo "$pkg"
done | sort -u > "$actual"

# **増えたものだけを見る。**記録は開発機（デスクトップ）で採ったもので、
# runner のほうがパッケージが少ないのは普通である（画像ローダーや IME の
# モジュールが入っていない）。**減るのは構わない。増えたら止める。**
# 記録のほうは `#` で始まる行を注釈として落としてから比べる。
recorded_clean=$(mktemp)
grep -vE '^[[:space:]]*(#|$)' "$recorded" | sort -u > "$recorded_clean"
added=$(comm -13 "$recorded_clean" "$actual")
rm -f "$recorded_clean"
if [ -n "$added" ]; then
  cat >&2 <<MSG

**記録に無いパッケージが同梱されようとしている。**

$added

条件を確かめてから $recorded に足すこと。見るのは
/usr/share/doc/<パッケージ>/copyright で、**GPL 一本縛りなら同梱しない**
（使っていない経路なら上の 1 で落とす）。LGPL なら、下で全文が
書き出されるので同梱してよい。
MSG
  exit 1
fi
echo "同梱パッケージ $(wc -l < "$actual") 件 — 記録の範囲内"

# ---------------------------------------------------------------------------
# 3. 条件の書き出し
# ---------------------------------------------------------------------------
# Release の資産としては、どの OS のものか分かる名前で出す。
# AppImage の中では、場所で分かるので素の名前でよい。
notice="$bundle/THIRD-PARTY-LICENSES-linux.txt"
{
  cat <<'HEADER'
================================================================================
gera — 同梱している第三者ソフトウェアの利用条件
gera — third-party licences bundled in this AppImage
================================================================================

この AppImage には、gera 本体（MIT ライセンス。同じ場所の LICENSE を見よ）の
ほかに、Ubuntu 24.04 由来の共有ライブラリが入っている。**それぞれの条件の
全文を下に載せてある。**

とくに WebKitGTK・GTK3・glib・cairo・pango・libsoup は **GNU 劣等一般公衆
利用許諾書（LGPL）** の下にある。LGPL は、利用者がこれらを差し替えられる
ことを求めている。この AppImage の中では、各ライブラリが独立した共有
ライブラリ（`usr/lib/*.so`）のまま置かれていて、**取り出して差し替えれば
そのまま動く。**AppImage は

    ./gera_*.AppImage --appimage-extract

で展開できる。

**ソースの入手先。**同梱しているものはすべて Ubuntu 24.04 (noble) の
パッケージそのままで、gera 側では改変していない。

    https://packages.ubuntu.com/source/noble/<ソースパッケージ名>

または Ubuntu 24.04 の環境で

    apt-get source <ソースパッケージ名>

--------------------------------------------------------------------------------
This AppImage bundles shared libraries from Ubuntu 24.04 alongside gera itself
(MIT; see the LICENSE file next to this one). The verbatim copyright and licence
text of every bundled package follows.

WebKitGTK, GTK3, glib, cairo, pango and libsoup are covered by the GNU Lesser
General Public License. They are bundled as separate, unmodified shared objects
under usr/lib/, so they can be extracted (`--appimage-extract`) and replaced.
The corresponding sources are the unmodified Ubuntu 24.04 (noble) packages,
available from https://packages.ubuntu.com/source/noble/<source-package> or via
`apt-get source <source-package>` on Ubuntu 24.04.
================================================================================
HEADER

  while read -r pkg; do
    src=$(dpkg-query -f '${source:Package}' -W "$pkg" 2>/dev/null || true)
    [ -n "$src" ] || src="$pkg"
    copyright="/usr/share/doc/$pkg/copyright"
    [ -f "$copyright" ] || { echo "$pkg の copyright が組んだ機械に無い" >&2; exit 1; }
    echo
    echo "================================================================================"
    echo "パッケージ / package: $pkg"
    echo "ソースパッケージ / source: $src"
    echo "  https://packages.ubuntu.com/source/noble/$src"
    echo "================================================================================"
    # **全文をそのまま載せる。**要約しない。要約は条件の提示にならない。
    cat "$copyright"
  done < "$actual"

  # Debian の copyright は、本文を `/usr/share/common-licenses/` への参照で
  # 逃がす書き方をする。**参照先も一緒に載せないと全文にならない。**
  for common in LGPL-2 LGPL-2.1 LGPL-3 GPL-2 GPL-3 Apache-2.0 BSD; do
    f="/usr/share/common-licenses/$common"
    [ -f "$f" ] || continue
    echo
    echo "================================================================================"
    echo "共通ライセンス全文 / full text: $common"
    echo "  (Debian/Ubuntu の /usr/share/common-licenses/$common)"
    echo "================================================================================"
    cat "$f"
  done
} > "$notice"

rm -f "$actual"

# **AppImage の中と、Release の資産の両方に置く。**中に入れるのは、
# ファイル一つだけを受け取った人がそのまま条件を読めるようにするため。
install -Dm644 "$notice" "$appdir/usr/share/doc/gera/$notice_name"
install -Dm644 "$repo/LICENSE" "$appdir/usr/share/doc/gera/LICENSE"
echo "条件を書き出した: $notice ($(wc -l < "$notice") 行)"

# ---------------------------------------------------------------------------
# 4. 詰め直す
# ---------------------------------------------------------------------------
# **tauri が使ったものと同じ道具で詰める。**`tauri build` が ~/.cache/tauri に
# 置いていったものをそのまま使う。別のものを取ってくると、出来上がりが
# tauri の作るものとずれる。
plugin="$HOME/.cache/tauri/linuxdeploy-plugin-appimage.AppImage"
[ -x "$plugin" ] || { echo "linuxdeploy-plugin-appimage が無い: $plugin" >&2; exit 1; }

rm -f "$bundle/$appimage"
# runner には FUSE が無いので、展開してから走らせる。NO_APPSTREAM は
# tauri 自身も立てている（AppStream のメタデータを作らせない）。
( cd "$bundle" && env APPIMAGE_EXTRACT_AND_RUN=1 NO_APPSTREAM=1 OUTPUT="$appimage" \
    "$plugin" --appdir "$appdir" )

[ -f "$bundle/$appimage" ] || { echo "詰め直しに失敗した" >&2; exit 1; }
chmod +x "$bundle/$appimage"
echo "詰め直した: $bundle/$appimage ($(du -h "$bundle/$appimage" | cut -f1))"
