// vault-web: テーマカラー（アクセントの色）。設定のページで選び、このブラウザの localStorage にだけ残す
// （vault には書かない）。選んだ1色から、ライトとダークそれぞれの文字・リンクの色などを作り、
// html の style に CSS 変数として置く。_vault_web_theme.scss はその変数を読み、なければ標準の紫を使う。

export const defaultAccent = "#7f6df2";
const accentKey = "vw-accent-color";

/** 設定のページに並べる色。名前は t(日本語, 英語) の順 */
export const accentPresets: { color: string; ja: string; en: string }[] = [
  { color: defaultAccent, ja: "紫", en: "Purple" },
  { color: "#3b82f6", ja: "青", en: "Blue" },
  { color: "#0891b2", ja: "水色", en: "Teal" },
  { color: "#16a34a", ja: "緑", en: "Green" },
  { color: "#ea580c", ja: "オレンジ", en: "Orange" },
  { color: "#e5484d", ja: "赤", en: "Red" },
  { color: "#db2777", ja: "ピンク", en: "Pink" },
  { color: "#6b7280", ja: "グレー", en: "Gray" },
];

type Rgb = [number, number, number];

const lightBackground: Rgb = [255, 255, 255];
const darkBackground: Rgb = [30, 30, 30]; // --root-background-color のダーク（#1e1e1e）

export function normalizeAccent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : undefined;
}

export function readAccent(storage: Pick<Storage, "getItem"> | undefined): string {
  return normalizeAccent(storage?.getItem(accentKey)) ?? defaultAccent;
}

function parse(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** a を b へ amount（0〜1）だけ近づける */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((c, i) => c + (b[i]! - c) * amount) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** 背景の上で読める濃さ（コントラスト比 4.5 以上）になるまで、toward へ少しずつ寄せる */
function readableOn(color: Rgb, background: Rgb, toward: Rgb): Rgb {
  for (let amount = 0; amount <= 1; amount += 0.05) {
    const candidate = mix(color, toward, amount);
    if (contrast(candidate, background) >= 4.5) return candidate;
  }
  return toward;
}

/** html の style に置く CSS 変数。標準の紫なら空（scss の標準の色をそのまま使う） */
export function accentVariables(accent: string): Record<string, string> {
  const hex = normalizeAccent(accent);
  if (!hex || hex === defaultAccent) return {};
  const rgb = parse(hex);
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  return {
    "--vw-accent": hex,
    "--vw-accent-rgb": rgb.join(", "),
    // ボタンなど、アクセントの色の上に置く文字
    "--vw-accent-contrast": contrast(white, rgb) >= 3 ? "#fff" : "#000",
    "--vw-accent-text-light": toHex(readableOn(rgb, lightBackground, black)),
    "--vw-accent-text-dark": toHex(readableOn(rgb, darkBackground, white)),
    "--vw-link-missing-light": toHex(mix(rgb, lightBackground, 0.4)),
    "--vw-link-missing-dark": toHex(mix(rgb, darkBackground, 0.35)),
  };
}

const variableNames = Object.keys(accentVariables("#000001"));

export function applyAccent(accent: string, root?: HTMLElement): void {
  const el = root ?? globalThis.document?.documentElement;
  if (!el) return;
  for (const name of variableNames) el.style.removeProperty(name);
  for (const [name, value] of Object.entries(accentVariables(accent))) {
    el.style.setProperty(name, value);
  }
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // 保存を止めているブラウザ
  }
}

export function saveAccent(accent: string): void {
  const hex = normalizeAccent(accent) ?? defaultAccent;
  try {
    if (hex === defaultAccent) storage()?.removeItem(accentKey);
    else storage()?.setItem(accentKey, hex);
  } catch {
    // 保存できなくても、この画面を開いている間は効く
  }
  applyAccent(hex);
}

export function clearAccent(): void {
  try {
    storage()?.removeItem(accentKey);
  } catch {
    // 消せなくても続ける
  }
}

// 起動したらすぐ当てる（一瞬紫で出ないように）
applyAccent(readAccent(storage()));
