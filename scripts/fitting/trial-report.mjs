import { join } from 'node:path';
import { durableWrite } from './trial-ledger.mjs';
import { sha256 } from './trial-plan.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function saveReport(out, loaded, report) {
  const sorted = [...report.results].sort((a, b) => a.id.localeCompare(b.id));
  const compositions = [], key = Object.fromEntries(sorted.map(({ id, itemId, input, variant }) => [id, { itemId, input, variant }]));
  for (const combination of loaded.plan.combinations || []) {
    for (const variant of ['without-features', 'with-features']) {
      for (const input of ['single', 'multi']) {
        const layers = combination.items.map(itemId => sorted.find(r => r.itemId === itemId && r.variant === variant && r.input === input)
          || sorted.find(r => r.itemId === itemId && r.variant === variant && r.input === 'single'));
        if (layers.some(l => !l) || (input === 'multi' && layers.every(l => l.input === 'single'))) continue;
        const order = { bottom: 0, shoes: 1, top: 2, head: 3 };
        layers.sort((a, b) => order[loaded.plan.items.find(i => i.id === a.itemId).category] - order[loaded.plan.items.find(i => i.id === b.itemId).category]);
        const id = sha256(`${loaded.plan.seed}:${combination.id}:${variant}:${input}`).slice(0, 12);
        compositions.push({ id, layers });
        key[id] = { combinationId: combination.id, variant, input, resolvedInputs: layers.map(l => ({ itemId: l.itemId, input: l.input })) };
      }
    }
  }
  compositions.sort((a, b) => a.id.localeCompare(b.id));
  report.compositions = compositions;
  await durableWrite(join(out, 'mannequin.png'), loaded.templatePng);
  await durableWrite(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const attribution = item => `<p>${escape(item.author)} · ${escape(item.license)}<br>${escape(item.source)}<br>Преобразование: ${report.mode === 'local-fixture' ? 'локальный тестовый ответ, не AI-иллюстрация' : 'генерация стилизованного изображения и сегментация; лицензия исходника сохраняется для применимых производных'}.</p>`;
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
  <title>Примерочная — проба</title><style>body{font:16px system-ui;background:#faf7f1;color:#282223;margin:24px}section{display:inline-block;vertical-align:top;padding:16px;max-width:520px;overflow-wrap:anywhere}.photo{width:240px;height:360px;object-fit:contain}.mannequin{position:relative;width:320px;height:320px}.mannequin img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style>
  <h1>${report.mode === 'local-fixture' ? 'Локальные ответы — не доказательство качества' : 'Результаты пробы — оценка качества ещё не выполнена'}</h1>
  <p>Состояние: ${escape(report.status)}. Рубрика и критерии фиксируются в плане; автоматического вывода go/no-go нет.</p>
  <p>Вырезки используют Photoroom sandbox: watermark может влиять на признаки и вид слоёв. Чистый production-результат этой пробой не подтверждается.</p>
  <h2>Отдельные вещи</h2>${sorted.map(r => `<section><h3>${escape(r.id)}</h3>${attribution(loaded.plan.items.find(i => i.id === r.itemId))}<img class="photo" src="${escape(r.original)}" alt="Исходная вещь"><img class="photo" src="${escape(r.artifact)}" alt="Иллюстрация"></section>`).join('')}
  <h2>Сочетания</h2>${compositions.map(c => `<section><h3>${escape(c.id)}</h3><div class="mannequin"><img src="mannequin.png" alt="Манекен">${c.layers.map(l => `<img class="garment-layer" src="${escape(l.artifact)}" alt="Слой вещи">`).join('')}</div>${c.layers.map(l => attribution(loaded.plan.items.find(i => i.id === l.itemId))).join('')}</section>`).join('')}</html>`;
  await durableWrite(join(out, 'review.html'), html);
  await durableWrite(join(out, 'answer-key.json'), JSON.stringify(key, null, 2));
}
