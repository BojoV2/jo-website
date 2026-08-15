import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// A4 portrait, used for pages built around an uploaded image.
const PAGE = [595.28, 841.89];
const MARGIN = 28;

// pdf-lib can only embed JPEG and PNG. Anything else (webp/gif/bmp) is converted
// with sharp when it is installed; without it the page falls back to a notice so
// the merge never fails because of one odd upload.
async function toEmbeddableImage(bytes, mimeType) {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return { kind: 'jpg', bytes };
  }
  if (mimeType === 'image/png') {
    return { kind: 'png', bytes };
  }
  try {
    const sharp = (await import('sharp')).default;
    const converted = await sharp(bytes).png().toBuffer();
    return { kind: 'png', bytes: converted };
  } catch (_err) {
    return null;
  }
}

function drawNotice(doc, font, lines) {
  const page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN - 40;
  for (const line of lines) {
    page.drawText(line, {
      x: MARGIN,
      y,
      size: 12,
      font,
      color: rgb(0.35, 0.35, 0.35)
    });
    y -= 18;
  }
  return page;
}

async function appendImagePage(doc, font, attachment, bytes) {
  const embeddable = await toEmbeddableImage(bytes, attachment.mime_type);
  if (!embeddable) {
    drawNotice(doc, font, [
      'Supporting document could not be rendered in this PDF.',
      `File: ${attachment.original_name || 'attachment'}`,
      `Type: ${attachment.mime_type || 'unknown'}`,
      'Open it from the Files panel in the portal instead.'
    ]);
    return;
  }

  const image = embeddable.kind === 'jpg'
    ? await doc.embedJpg(embeddable.bytes)
    : await doc.embedPng(embeddable.bytes);

  const page = doc.addPage(PAGE);
  const maxWidth = PAGE[0] - MARGIN * 2;
  const maxHeight = PAGE[1] - MARGIN * 2;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: (PAGE[0] - width) / 2,
    y: (PAGE[1] - height) / 2,
    width,
    height
  });
}

/**
 * Build "page 1 = the generated document, then one or more pages per supporting
 * document" as a single PDF. The stored base file is never modified; this is
 * assembled per request so it always reflects the attachments that exist now.
 *
 * @param {string} basePath absolute path to the generated PDF
 * @param {Array<{file_path: string, mime_type: string, original_name: string}>} attachments
 * @param {string} storageRoot absolute storage root the file_path values are relative to
 * @returns {Promise<{bytes: Uint8Array, appended: number, skipped: number}>}
 */
export async function buildMergedPdf(basePath, attachments, storageRoot) {
  const baseBytes = fs.readFileSync(basePath);
  const merged = await PDFDocument.create();
  const font = await merged.embedFont(StandardFonts.Helvetica);

  const base = await PDFDocument.load(baseBytes);
  const basePages = await merged.copyPages(base, base.getPageIndices());
  for (const page of basePages) {
    merged.addPage(page);
  }

  let appended = 0;
  let skipped = 0;

  for (const attachment of attachments) {
    const abs = path.join(storageRoot, attachment.file_path || '');
    try {
      if (!attachment.file_path || !fs.existsSync(abs)) {
        skipped += 1;
        continue;
      }
      const bytes = fs.readFileSync(abs);

      if (attachment.mime_type === 'application/pdf') {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        for (const page of pages) {
          merged.addPage(page);
        }
      } else {
        await appendImagePage(merged, font, attachment, bytes);
      }
      appended += 1;
    } catch (err) {
      // One bad upload must not cost the user the whole document.
      skipped += 1;
      drawNotice(merged, font, [
        'Supporting document could not be included.',
        `File: ${attachment.original_name || 'attachment'}`,
        `Reason: ${err.message}`
      ]);
    }
  }

  return { bytes: await merged.save(), appended, skipped };
}
