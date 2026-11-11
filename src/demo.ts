export interface DemoTitle { id: string; title: string; subtitle: string; year: string; genre: string; description: string; art: string }
export const demoTitles: DemoTitle[] = [
  { id: 'orbit', title: 'Тихая орбита', subtitle: 'THE QUIET ORBIT', year: '2026', genre: 'Фантастика', art: 'orbit', description: 'На краю звёздной карты остаётся один сигнал. Вымышленный фильм для знакомства с интерфейсом Rezzka.' },
  { id: 'coast', title: 'За горизонтом', subtitle: 'BEYOND THE TIDE', year: '2025', genre: 'Приключения', art: 'coast', description: 'Один берег, тысяча возможных дорог. Вымышленный фильм для знакомства с интерфейсом Rezzka.' },
  { id: 'city', title: 'После полуночи', subtitle: 'AFTER MIDNIGHT', year: '2026', genre: 'Драма', art: 'city', description: 'Город замолкает, чтобы услышать одну историю. Вымышленный фильм для знакомства с интерфейсом Rezzka.' },
  { id: 'forest', title: 'Глубина леса', subtitle: 'INTO THE GREEN', year: '2025', genre: 'Приключения', art: 'forest', description: 'Иногда дорога домой начинается с первого шага в неизвестность. Вымышленный фильм для знакомства с интерфейсом Rezzka.' },
  { id: 'sand', title: 'Линия света', subtitle: 'A LINE OF LIGHT', year: '2026', genre: 'Фантастика', art: 'sand', description: 'Следы на песке исчезают. Истории остаются. Вымышленный фильм для знакомства с интерфейсом Rezzka.' },
];
const historyKey = 'rezzka.demo.progress.v1';
export function readDemoProgress(id: string): number {
  try { const value = JSON.parse(localStorage.getItem(historyKey) || '{}')[id]; return typeof value === 'number' && Number.isFinite(value) ? value : 0; } catch { return 0; }
}
export function writeDemoProgress(id: string, seconds: number) {
  try { const history = JSON.parse(localStorage.getItem(historyKey) || '{}'); localStorage.setItem(historyKey, JSON.stringify({ ...history, [id]: seconds })); } catch { /* Storage can be unavailable on the device. Playback remains usable. */ }
}
export function clearDemoProgress() { try { localStorage.removeItem(historyKey); } catch { /* Optional demo history. */ } }
