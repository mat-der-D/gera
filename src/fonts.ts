/**
 * 第5節の要——書体でモードを示す判断——が実際に成立しているかを起動時に測る。
 *
 * 単一のファミリー名だけを書くと、未導入の環境で黙って fallback し、
 * 両モードが同じ書体で組まれて、状態表示が無言で失われる。
 * それを検知できないまま配布しないために、解決結果を log に出す。
 */

const PROBE = "あいうえお永国漢字ABC";

function measure(ctx: CanvasRenderingContext2D, family: string): number {
  ctx.font = `72px ${family}`;
  return ctx.measureText(PROBE).width;
}

/** 指定したファミリーが実際に解決されるか（fallback されていないか）。 */
export function fontAvailable(family: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  // 二つの異なる総称フォントを土台にして、どちらに対しても幅が動けば解決している。
  return (["monospace", "sans-serif"] as const).every((generic) => {
    const base = measure(ctx, generic);
    const test = measure(ctx, `"${family}", ${generic}`);
    return Math.abs(test - base) > 0.5;
  });
}

function familiesOf(cssVar: string): string[] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
  return value
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter((f) => f && !["serif", "sans-serif", "monospace"].includes(f));
}

/** スタックのうち最初に解決したファミリー。どれも無ければ null。 */
export function resolvedFamily(cssVar: string): string | null {
  return familiesOf(cssVar).find(fontAvailable) ?? null;
}

/**
 * 明朝とゴシックが両方解決し、かつ互いに別物であることを確かめる。
 * 同じ書体に落ちていれば、モード表示としては機能していない。
 */
export function reportFontResolution(): void {
  const serif = resolvedFamily("--font-serif");
  const sans = resolvedFamily("--font-sans");

  console.info(`[gera] 明朝: ${serif ?? "解決せず"} / ゴシック: ${sans ?? "解決せず"}`);

  if (!serif || !sans) {
    console.warn(
      "[gera] 明朝かゴシックが解決していない。書体によるモード表示が機能しない " +
        "（設計 第5節: この判断が成立しなければミニマル案は成立しない）。",
    );
  } else if (serif === sans) {
    console.warn(`[gera] 明朝とゴシックが同じ書体 (${serif}) に解決している。モード表示が機能しない。`);
  }
}
