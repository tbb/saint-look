import sharp from 'sharp';

// Deliberately synthetic: ticket #2 verifies plumbing, not segmentation quality.
export async function demoResult() {
  const size = 128;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 15; y < 116; y++) {
    for (let x = 12; x < 116; x++) {
      const torso = x >= 36 && x < 92;
      const sleeve = y < 48 && (x < 44 || x >= 84);
      const collar = y < 30 && x >= 52 && x < 76;
      if ((torso || sleeve) && !collar) {
        pixels.set([40, 92, 190, 255], (y * size + x) * 4);
      }
    }
  }
  return { image: await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer(),
    type: 'Футболка', colors: ['Синий'] };
}
