import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const invisiblePdfTextPattern = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const whitespacePdfTextPattern = /[\r\n\t]+/g;
const pdfTextReplacementMap = new Map([
  ['\u00A0', ' '],
  ['\u2000', ' '],
  ['\u2001', ' '],
  ['\u2002', ' '],
  ['\u2003', ' '],
  ['\u2004', ' '],
  ['\u2005', ' '],
  ['\u2006', ' '],
  ['\u2007', ' '],
  ['\u2008', ' '],
  ['\u2009', ' '],
  ['\u200A', ' '],
  ['\u2010', '-'],
  ['\u2011', '-'],
  ['\u2012', '-'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2015', '-'],
  ['\u2018', '\''],
  ['\u2019', '\''],
  ['\u201A', '\''],
  ['\u201B', '\''],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u201E', '"'],
  ['\u2022', '*'],
  ['\u2026', '...'],
  ['\u2212', '-']
]);

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

function isCheckedCheckboxValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'checked', 'on'].includes(normalized);
  }
  return false;
}

export function sanitizePdfText(value, font) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(invisiblePdfTextPattern, '')
    .replace(whitespacePdfTextPattern, ' ');

  let sanitized = '';
  for (const character of normalized) {
    const candidate = pdfTextReplacementMap.get(character) ?? character;
    try {
      font.encodeText(candidate);
      sanitized += candidate;
    } catch (_err) {
      // Drop characters the embedded WinAnsi font cannot encode.
    }
  }

  return sanitized;
}

function drawCheckboxMark(page, field) {
  const x = Number(field.x_position);
  const y = Number(field.y_position);
  const width = Math.max(10, Number(field.box_width || 12));
  const height = Math.max(10, Number(field.box_height || 12));
  const thickness = Math.max(1.5, Math.min(width, height) * 0.1);
  const startX = x + width * 0.18;
  const startY = y + height * 0.4;
  const midX = x + width * 0.42;
  const midY = y + height * 0.15;
  const endX = x + width * 0.82;
  const endY = y + height * 0.78;

  page.drawLine({
    start: { x: startX, y: startY },
    end: { x: midX, y: midY },
    thickness,
    color: rgb(0, 0, 0)
  });

  page.drawLine({
    start: { x: midX, y: midY },
    end: { x: endX, y: endY },
    thickness,
    color: rgb(0, 0, 0)
  });
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

    if (field.field_type === 'checkbox') {
      if (isCheckedCheckboxValue(value)) {
        drawCheckboxMark(page, field);
      }
      continue;
    }

    const text = sanitizePdfText(value, font);
    if (!text) {
      continue;
    }
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
