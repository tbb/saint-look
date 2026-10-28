// Deterministic local drawing fixtures, not generated garments or quality evidence.
// Run manually with the repository's installed backend sharp dependency.
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../SaintLook/VisualFixtures/', import.meta.url);
const shapes = {
  tee: '<path fill="#f3dfaf" stroke="#b19b6c" stroke-width="2" d="M147 144 L164 136 Q180 151 196 136 L216 145 L232 186 L214 198 L207 179 L214 280 Q180 289 144 280 L151 179 L143 198 L126 185 Z"/><path fill="none" stroke="#b19b6c" stroke-width="2" d="M164 136 Q180 160 196 136"/><rect x="166" y="179" width="28" height="17" rx="3" fill="#797e56"/>',
  jacket: '<g fill="#76384f" stroke="#4d2636" stroke-width="2"><path d="M140 144 L162 135 L171 158 L164 310 L135 315 L139 212 L120 287 L104 281 L120 175 Q126 150 140 144Z"/><path d="M198 135 L221 145 Q238 151 243 179 L258 281 L241 287 L218 212 L225 315 L195 310 L188 158Z"/></g><path fill="#a75d72" d="M162 135 L171 158 L162 205 L153 162Z M198 135 L188 158 L197 205 L207 162Z"/><path fill="none" stroke="#bb8392" stroke-width="2" d="M143 250 L159 250 M201 250 L217 250"/>',
  jeans: '<path fill="#456887" stroke="#29485f" stroke-width="2" d="M141 267 Q180 280 220 267 L224 317 L214 491 L195 493 L181 360 L164 493 L144 490 L139 320Z"/><path fill="none" stroke="#a2b9c8" stroke-width="1.5" d="M145 280 Q180 291 217 280 M179 284 L181 349 M145 296 L161 302 M216 296 L201 302"/>',
  shoes: '<g fill="#283434" stroke="#182425" stroke-width="2"><path d="M144 488 L164 490 L166 510 Q153 521 131 514 L129 507Z"/><path d="M195 490 L215 488 L230 507 L228 514 Q206 521 193 510Z"/></g><path fill="none" stroke="#e4d9c6" stroke-width="4" d="M130 511 Q150 518 165 509 M194 509 Q212 518 229 511"/>',
};
await mkdir(output, { recursive: true });
for (const [name, body] of Object.entries(shapes)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-100 0 560 560"><title>Saint Look deterministic TEST fixture: ${name}</title>${body}</svg>`;
  await writeFile(new URL(`fitting-${name}.svg`, output), svg + '\n');
  await sharp(Buffer.from(svg)).png().toFile(new URL(`fitting-${name}.png`, output).pathname);
}
