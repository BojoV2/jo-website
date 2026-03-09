import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sanitizePdfText } from '../src/services/pdfService.js';

describe('sanitizePdfText', () => {
  it('removes hidden bidi markers that WinAnsi cannot encode', async () => {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const result = sanitizePdfText('Venson\u200e Wednesday', font);

    expect(result).toBe('Venson Wednesday');
    expect(() => font.encodeText(result)).not.toThrow();
  });

  it('normalizes common pasted punctuation into encodable text', async () => {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const result = sanitizePdfText('“Client”\nAddress — Block 2…', font);

    expect(result).toBe('"Client" Address - Block 2...');
    expect(() => font.encodeText(result)).not.toThrow();
  });
});
