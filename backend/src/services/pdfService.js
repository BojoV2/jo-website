import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

function computeAutoFontSize(font, text, boxWidth, boxHeight, manualSize = 12) {
  const heightBased = Math.max(6, Number(boxHeight) * 0.75);
  if (!boxWidth || Number(boxWidth) <= 0) {
    return heightBased;
  }

  const widthAtSizeOne = font.widthOfTextAtSize(text, 1);
  if (!widthAtSizeOne || widthAtSizeOne <= 0) {
    return heightBased;
  }

  const widthBased = Number(boxWidth) / widthAtSizeOne;
  const fitted = Math.min(heightBased, widthBased);

  // Keep text readable: avoid shrinking too aggressively for long values.
  const minReadable = Math.max(6, Math.min(heightBased, Number(manualSize || 12) * 0.75));
  return Math.max(minReadable, fitted);
}

function generateOrderNumber() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${datePart}-${randomPart}`;
}

export async function generatePdfFromTemplate({ templatePath, fields, payload, outputPath }) {
  const bytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const orderNumberValue = generateOrderNumber();

  for (const field of fields) {
    const value = field.field_type === 'order_number'
      ? orderNumberValue
      : payload[field.field_name];
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const pageIndex = field.page_number - 1;
    const page = pdfDoc.getPage(pageIndex);

    if (!page) {
      throw new Error(`Invalid page number ${field.page_number} for field ${field.field_name}`);
    }

    const text = String(value);
    const manualSize = Number(field.font_size || 12);
    const autoFontEnabled = field.auto_font !== false;

    const resolvedSize = autoFontEnabled && field.box_height
      ? computeAutoFontSize(font, text, field.box_width, field.box_height, manualSize)
      : manualSize;

    page.drawText(text, {
      x: Number(field.x_position),
      y: Number(field.y_position),
      size: resolvedSize,
      lineHeight: resolvedSize * 1.15,
      wordBreaks: [' ', '-', '_', '/'],
      maxWidth: field.box_width ? Number(field.box_width) : undefined,
      font,
      color: rgb(0, 0, 0)
    });
  }

  const outBytes = await pdfDoc.save();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outBytes);
}
