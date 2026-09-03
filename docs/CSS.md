# 見た目を自分で変える

gera の閲覧モードは、**素の HTML と、数えるほどのクラス名**でできている。CSS を書けば、既定の版面をいくらでも差し替えられる。設定画面は無い（設計文書 第9-4節）。

**ここに挙げたクラス名と CSS 変数は公開 API である。**実装の都合で勝手に変えない。

> **いまはまだ、書いた CSS を読み込ませる仕組みが無い。**ユーザー CSS の読み込みは実装順序 7（設計文書 第14節）で、この文書はその一つ前——**名前を決めて公開する**段階のものである。いま試すなら開発時の `npm run dev` で `src/viewer.css` を直接いじることになる。

---

## いちばん短い例——明朝をやめる

既定は明朝で組んである。読みづらければ、**これだけで全部ゴシックになる。**

```css
:root {
  --font-serif: "Yu Gothic", YuGothic, "Noto Sans CJK JP", "Hiragino Sans", Meiryo, sans-serif;
}
```

`--font-serif` は「明朝を入れる変数」ではなく「**本文の書体**を入れる変数」である。ここにゴシックを入れれば本文がゴシックになる。

書体だけでなく、**大きさと行間まで好みに合わせる**なら次のように書く。ゴシックは明朝より字面が大きいので、同じ行間だと詰まって見える。

```css
:root {
  --font-serif: "Yu Gothic", YuGothic, "Noto Sans CJK JP", sans-serif;
  --font-size-view: 16px;   /* 閲覧モードの基準。既定は 17px */
}
.gera-doc {
  line-height: 2.1;         /* 既定は 1.95 */
}
```

**大きさは `.gera-doc { font-size: … }` ではなく `--font-size-view` で指定する。**前者で書くと `calc(var(--font-size-view) * var(--font-scale))` ごと上書きしてしまい、**`Mod +` / `Mod -` が効かなくなる。**理由は次節に書いた。

---

## 色と書体——CSS 変数

`src/style.css` が持っている変数で、**編集モードと閲覧モードの両方に効く。**`:root` に上書きを書く。

| 変数 | 何に使われるか |
|---|---|
| `--font-serif` | **本文の書体。**既定は明朝 |
| `--font-sans` | 通知の帯などの補助的な文字 |
| `--font-mono` | コード、インラインコード、数式の変換に失敗したところ |
| `--bg` | ウィンドウの地色 |
| `--fg` | 本文の文字色 |
| `--dim` | 薄い文字（`h6`、取り消し線、通知の帯） |
| `--rule` | 罫線（`h2` の下、`hr`、表の枠、コードの枠、引用の縦線） |
| `--accent` | リンクの色、箇条書きの点、チェックボックス |
| `--code-bg` | コードと表の見出し行の地色 |
| `--sel` | 選択範囲（編集モード） |
| `--zebra` | 表の偶数行の地色 |

ダークモードは OS の設定（`prefers-color-scheme`）に従って変数が入れ替わる。**片方だけ変えたいなら、メディアクエリの中に書く。**

```css
@media (prefers-color-scheme: dark) {
  :root { --bg: #101010; --fg: #d8d8d8; }
}
```

---

## 字の大きさ——基準と倍率

字の大きさは**キーボードでも変えられる**（`Mod +` / `Mod -` / `Mod 0`）。**利用者 CSS とキーボード操作が同じ値を奪い合わないよう、基準と倍率を別の変数に分けてある。**実際の指定は次の 2 行だけである（`src/style.css` と `src/viewer.css`）。

```css
.gera-doc       { font-size: calc(var(--font-size-view) * var(--font-scale)); }
#app .cm-editor { font-size: calc(var(--font-size-edit) * var(--font-scale)); }
```

| 変数 | 既定 | 意味 | 利用者 CSS |
|---|---|---|---|
| `--font-size-view` | `17px` | **閲覧モードの基準** | **ここを上書きする** |
| `--font-size-edit` | `16px` | **編集モードの基準** | **ここを上書きする** |
| `--font-scale` | `1` | 倍率。`Mod +` / `Mod -` / `Mod 0` だけが触る | **触らないこと** |

- **上書きしてよいのは基準（`--font-size-view` / `--font-size-edit`）だけである。**倍率を CSS で固定すると、`Mod +` / `Mod -` が書き込んだ値が打ち消され、**キーボードで大きさが変わらなくなる**
- **`Mod 0` は倍率を 1 に戻すだけで、基準には触れない。**つまり戻り先は「**利用者が CSS で決めた大きさ**」であって、gera の既定 17px ではない。**利用者の設定を消す「戻す」は不具合である**という判断による
- **基準が二つに分かれているのは、閲覧と編集で書体が違うからである。**閲覧は明朝 17px、編集はゴシック 16px で、それぞれの書体の字面に合わせた寸法である。**片方に揃えるとどちらかの版面が崩れる**
- **見出し・コード・表・数式の寸法はすべて `em` の相対指定である。**したがって**基準を変えれば版面全体が比例して動く。**個別の要素を一つずつ直す必要はない

**友人向けの実用例——ゴシックにして、好みの大きさにする。**

```css
:root {
  /* 種類: 本文の書体をゴシックにする */
  --font-serif: "Yu Gothic", YuGothic, "Noto Sans CJK JP", "Hiragino Sans", Meiryo, sans-serif;
  /* 大きさ: 基準だけを動かす。倍率（--font-scale）には触らない */
  --font-size-view: 18px;   /* 既定は 17px */
  --font-size-edit: 17px;   /* 既定は 16px */
}
.gera-doc {
  line-height: 2.1;         /* ゴシックは字面が大きいので行間を足す。既定は 1.95 */
}
```

これを書いた上でも `Mod +` / `Mod -` は効き、`Mod 0` は 18px に戻る。

---

## 閲覧モードの構造

閲覧モードの DOM はこの形をしている。**トップレベルのブロックが平らに並ぶ**だけで、入れ子の器は無い。

```html
<div class="gera-view">          <!-- スクロールする器。外側の余白はここ -->
  <article class="gera-doc">     <!-- 本文。書体・行長・行間・文字色はここ -->
    <h1 id="見出しの綴り" data-line="0" data-line-end="1">…</h1>
    <p data-line="2" data-line-end="3">…</p>
    <ul data-line="4" data-line-end="7">
      <li class="gera-task"><input type="checkbox" disabled> …</li>
    </ul>
    <div class="gera-table" data-line="…">
      <table>…</table>
    </div>
    <pre data-line="…"><code>…</code></pre>
    <div class="gera-math" data-line="…">   <!-- $$…$$ の別行立て -->
      <p class="katex-block"><span class="katex">…</span></p>
    </div>
  </article>
</div>
```

### クラス名

| 名前 | 何か | よくある上書き |
|---|---|---|
| `.gera-view` | スクロールする器 | 上下左右の余白（`padding`） |
| `.gera-doc` | 本文全体 | 書体、行長（`max-width`）、行間、文字の大きさ |
| `.gera-table` | 表を包む箱 | 表だけの横スクロールをやめる、余白を変える |
| `.gera-math` | `$$…$$` の別行立て数式を包む箱 | 余白、左寄せにする |
| `.gera-task` | `- [ ]` で書いたタスクの項目（`li` に付く） | チェックボックスの位置 |

**これ以外の見た目は、素の要素名で書ける。**`.gera-doc h2`、`.gera-doc p`、`.gera-doc blockquote`、`.gera-doc pre`、`.gera-doc table`、`.gera-doc a`、`.gera-doc details` のように、`.gera-doc` の下に普通のセレクタを並べればよい。gera の側で独自のクラスを増やしていないのは、**覚えるべき名前を増やさないため**である。

### KaTeX の名前

数式は KaTeX が描くので、その中のクラス名は KaTeX のものである（`.katex`、`.katex-block`、`.katex-display`、`.katex-error` など）。gera が決めた名前ではないので、**KaTeX の版が上がると変わりうる。**変えてよいのは大きさくらいにしておくのが安全である。

```css
.gera-doc .katex { font-size: 1.15em; }   /* 既定は 1.08em */
```

### `data-line` と `id`

- `data-line` / `data-line-end` は、そのブロックが元の Markdown の何行目から何行目までかを表す（0 始まり、終端は含まない）。編集モードと行き来したときに同じ場所へ戻るために使っている。**見た目のために使うものではないが、セレクタとしては使える**
- 見出しの `id` は GitHub と同じ綴り（小文字化し、ASCII の記号を落とし、空白を `-` にする）。`[…](#見出し)` のリンクがこれを目指して飛ぶ

---

## 触らないほうがよいもの

**`content-visibility` と `contain-intrinsic-size` を消さないこと。**`.gera-doc > *` に付いていて、画面の外にあるブロックを描く仕事から外している。数式の多い文書では、これが有るかどうかで最初の一枚が出るまでが 800 ms と 1,000 ms 以上に分かれる。

うっかり消してしまうのは、次のような書き方である。

```css
/* これをやると content-visibility ごと上書きされる */
.gera-doc > * { contain: none; }
```

余白や色を変えたいだけなら、`content-visibility` に触れない書き方をすればよい。

```css
.gera-doc > p { margin: 1.2em 0; }   /* こちらは安全 */
```

**`contain-intrinsic-size` を px で書き直さないこと。**gera は `.gera-doc > *` および見出し・箇条書き・コード・表・数式の各ブロックに、**`em` で**推定の高さを与えている（`.gera-doc > h1` なら `auto 1.53em` のように、要素ごとに違う値）。

**`em` なのは、字の大きさが二方向に動くからである。**基準（利用者 CSS の `--font-size-view`）でも倍率（`Mod +` / `Mod -`）でも `.gera-doc` の `font-size` は動く。`em` は自分の `font-size` に対する比なので、**どちらが動いても推定が同じ比のまま付いてくる。**px で固定すると**拡大したときだけ推定が小さいまま取り残され**、画面外の文書が実際より短く見積もられる。**結果としてスクロールバーの長さが縮み、送るたびに位置が跳ねる。**

推定を消してしまうのも同じ害を招く。`contain-intrinsic-size` の無い `content-visibility: auto` は画面外の高さを 0 と見なすため、**文書全体の高さが縮んでスクロールが暴れる。**
