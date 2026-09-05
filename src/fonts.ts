/**
 * Measures at launch whether the crux of §5 — the decision to indicate the mode by
 * typeface — actually holds.
 *
 * If only a single family name were written, an environment without it installed
 * would silently fall back, both modes would be set in the same typeface, and the
 * state indication would be lost without a word. So that this is never shipped
 * undetected, the resolution result is written to the log.
 */

const PROBE = "あいうえお永国漢字ABC";

function measure(ctx: CanvasRenderingContext2D, family: string): number {
  ctx.font = `72px ${family}`;
  return ctx.measureText(PROBE).width;
}

/** Whether the given family actually resolves (that is, has not fallen back). */
export function fontAvailable(family: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  // Use two different generic fonts as the baseline: if the width moves against both
  // of them, the family has resolved.
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

/** The first family in the stack that resolves. `null` if none of them do. */
export function resolvedFamily(cssVar: string): string | null {
  return familiesOf(cssVar).find(fontAvailable) ?? null;
}

/**
 * Confirms that the serif (mincho) and sans-serif (gothic) faces both resolve, and
 * that they are different from one another. If they have landed on the same
 * typeface, the mode indication is not working.
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
