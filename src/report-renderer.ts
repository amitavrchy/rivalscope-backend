import PDFDocument from 'pdfkit';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { existsSync } from 'node:fs';
import { env } from './config.js';

export type ReportSection = { heading: string; text: string };
export async function renderDocx(title: string, sections: ReportSection[]) {
  const doc = new Document({ sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...sections.flatMap(section => [new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }), ...section.text.split('\n').map(text => new Paragraph({ children: [new TextRun({ text, size: 24 })], spacing: { after: 160 } }))])] }] });
  return Packer.toBuffer(doc);
}
export async function renderPdf(title: string, sections: ReportSection[]) {
  const fontPaths = [env.REPORT_FONT_PATH, 'assets/NotoSansBengali.ttf', 'C:/Windows/Fonts/Nirmala.ttf', '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf'].filter((p): p is string => !!p);
  const font = fontPaths.find(path => existsSync(path));
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, right: 50, bottom: 50, left: 50 }, bufferPages: true, info: { Title: title, Author: 'RivalScope AI' } });
  const chunks: Buffer[] = []; const finished = new Promise<Buffer>((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk as Buffer)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  if (font) doc.font(font);
  else if (/[\u0980-\u09ff]/.test(title + sections.map(s => s.text).join(''))) throw new Error('A Bengali-compatible REPORT_FONT_PATH is required for this report');
  doc.fontSize(23).text(title).moveDown();
  for (const section of sections) { if (doc.y > 700) doc.addPage(); doc.fontSize(16).text(section.heading).moveDown(0.4); doc.fontSize(14).text(section.text, { lineGap: 5 }).moveDown(); }
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) { doc.switchToPage(index); doc.fontSize(14).text(`RivalScope AI | ${index + 1} / ${range.count}`, 50, 805, { lineBreak: false }); }
  doc.end(); return finished;
}
