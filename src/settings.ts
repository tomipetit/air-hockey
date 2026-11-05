import type { CpuLevel } from './ai/cpu';
import type { ViewMode } from './render/camera';
import type { Quality } from './render/neon';

export interface Settings {
  quality: Quality;
  view: ViewMode;
  cpu: CpuLevel;
  sound: boolean;
}

const KEY = 'neon-air-hockey:settings';
const DEFAULTS: Settings = { quality: 'high', view: 'perspective', cpu: 'normal', sound: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* 保存できない環境では既定値 */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 無視 */
  }
}

type Option<T> = { value: T; label: string };
const ROWS: { key: keyof Settings; label: string; options: Option<Settings[keyof Settings]>[] }[] = [
  {
    key: 'cpu',
    label: 'CPU の強さ',
    options: [
      { value: 'easy', label: '弱' },
      { value: 'normal', label: '中' },
      { value: 'hard', label: '強' },
    ],
  },
  {
    key: 'view',
    label: '視点',
    options: [
      { value: 'perspective', label: '3D' },
      { value: 'top', label: '真上' },
    ],
  },
  {
    key: 'quality',
    label: 'エフェクト',
    options: [
      { value: 'high', label: '高' },
      { value: 'low', label: '低' },
    ],
  },
  {
    key: 'sound',
    label: 'サウンド',
    options: [
      { value: true, label: 'ON' },
      { value: false, label: 'OFF' },
    ],
  },
];

/** 設定の切り替えボタン群を container に描画する */
export function renderSettings(container: HTMLElement, s: Settings, onChange: (s: Settings) => void): void {
  container.replaceChildren();
  for (const row of ROWS) {
    const wrap = document.createElement('div');
    wrap.className = 'setting';
    const label = document.createElement('span');
    label.className = 'setting-label';
    label.textContent = row.label;
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', row.label);
    for (const opt of row.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.setAttribute('aria-pressed', String(s[row.key] === opt.value));
      b.addEventListener('click', () => {
        (s as unknown as Record<string, unknown>)[row.key] = opt.value;
        saveSettings(s);
        onChange(s);
        renderSettings(container, s, onChange);
      });
      seg.append(b);
    }
    wrap.append(label, seg);
    container.append(wrap);
  }
}
