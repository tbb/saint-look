import sharp from 'sharp';

export class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const maximumBody = 8 * 1024 * 1024;
const maximumImage = 5 * 1024 * 1024;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readUpload(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, 'unsupported_content_type');
  }
  if (Number(request.headers['content-length']) > maximumBody) {
    request.resume();
    throw new RequestError(413, 'image_too_large');
  }
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > maximumBody) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestError(413, 'image_too_large'));
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new RequestError(400, 'invalid_request')));
  });
  let input;
  try { input = JSON.parse(body.toString('utf8')); } catch { throw new RequestError(400, 'invalid_request'); }
  if (!input || ['itemId', 'operationId', 'photoVersionId'].some((field) => typeof input[field] !== 'string' || !uuid.test(input[field]))) {
    throw new RequestError(400, 'invalid_identity');
  }
  if (typeof input.imageBase64 !== 'string' || !input.imageBase64.length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.imageBase64)) {
    throw new RequestError(400, 'invalid_image');
  }
  const image = Buffer.from(input.imageBase64, 'base64');
  if (image.length > maximumImage) throw new RequestError(413, 'image_too_large');
  const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const png = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) throw new RequestError(415, 'unsupported_image');
  try {
    const decoder = sharp(image, { limitInputPixels: 16_000_000, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if ((metadata.pages || 1) !== 1) throw new Error('Animated input');
    // No keepMetadata/withMetadata: pixels are oriented, metadata is discarded.
    const source = await decoder.rotate().png().toBuffer();
    return { itemId: input.itemId.toLowerCase(), operationId: input.operationId.toLowerCase(),
      photoVersionId: input.photoVersionId.toLowerCase(), source, revision: input.revision, action: input.action };
  } catch {
    throw new RequestError(400, 'invalid_image');
  }
}
