const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { PDFDocument } = require('pdf-lib');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
app.use(cors({
  origin: ['https://amorinilogisticsinterstatebookings.netlify.app', 'http://localhost:3000']
}));
 
app.use(express.json({ limit: '50mb' }));
 
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
// Simple request queue to prevent concurrent Claude API calls
let requestQueue = Promise.resolve();
 
// Cabinet finish prefixes to strip
const CABINET_PREFIXES = [
  'PMW', 'PJMW', 'OLOA', 'ESC', 'EMW', 'OCO', 'ESO', 'ESS',
  'OAO', 'OCW', 'OHO', 'ONB', 'OSPO', 'OMW', 'SMC', 'SMN',
  'SMS', 'PGW', 'PSN', 'SDA', 'ND'
];
 
// Codes to exclude entirely — hardware/filler items not needed for CBM
const EXCLUDED_CODES = new Set([
  'DW605', 'FLUPANEL', 'DRILLINPUSHCATCH', 'IADJL'
]);
 
function processCode(rawCode) {
  const upper = rawCode.toUpperCase().replace(/_+$/, '').trim();
  if (EXCLUDED_CODES.has(upper)) return null;
  if (upper.startsWith('CUSTOM')) return null;
  if (upper.startsWith('BXP') || upper.startsWith('DEK')) return upper;
 
  const prefixMatch = upper.match(
    new RegExp(`^(${CABINET_PREFIXES.join('|')})-(.+)$`)
  );
 
  if (!prefixMatch) return upper;
 
  const suffix = prefixMatch[2];
  const multiLetterCabinet = /^[A-Z]{2,}\d/.test(suffix);
  const singleLetterCabinet = /^[BWPSTVLU]\d/.test(suffix);
  const isCabinetSuffix = multiLetterCabinet || singleLetterCabinet;
 
  return isCabinetSuffix ? suffix : upper;
}
 
function isBenchtop(code) {
  return code.startsWith('BXP') || code.startsWith('DEK');
}
 
async function callClaude(chunkBase64, prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunkBase64 } },
              { type: 'text', text: prompt }
            ]
          }]
        })
      });
 
      const data = await response.json();
 
      if (data.error) {
        const isRateLimit = data.error.type === 'rate_limit_error' || response.status === 429;
        console.error(`Claude error (attempt ${attempt}):`, data.error.message || data.error);
        if (isRateLimit && attempt < retries) {
          const wait = attempt * 20000;
          console.log(`Rate limited — waiting ${wait / 1000}s before retry...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return null;
      }
 
      return data.content?.find(b => b.type === 'text')?.text?.trim() || null;
 
    } catch (err) {
      console.error(`Claude fetch error (attempt ${attempt}):`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, attempt * 5000));
      }
    }
  }
  return null;
}
 
app.post('/extract', (req, res) => {
  // Queue requests so they run sequentially — prevents concurrent Claude API calls
  requestQueue = requestQueue.then(() => handleExtract(req, res));
});
 
async function handleExtract(req, res) {
  try {
    const { pdfBase64 } = req.body;
 
    if (!pdfBase64) return res.status(400).json({ error: 'No PDF data received' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
 
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
 
    const CHUNK_SIZE = 40;
    const chunks = [];
 
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      console.log(`PDF loaded: ${totalPages} pages`);
 
      if (totalPages <= CHUNK_SIZE) {
        chunks.push(pdfBase64);
      } else {
        for (let start = 0; start < totalPages; start += CHUNK_SIZE) {
          const end = Math.min(start + CHUNK_SIZE, totalPages);
          const subDoc = await PDFDocument.create();
          const indices = Array.from({ length: end - start }, (_, i) => start + i);
          const copiedPages = await subDoc.copyPages(pdfDoc, indices);
          copiedPages.forEach(p => subDoc.addPage(p));
          const subBytes = await subDoc.save();
          chunks.push(Buffer.from(subBytes).toString('base64'));
          console.log(`Chunk created: pages ${start}-${end - 1}`);
        }
      }
    } catch (splitErr) {
      console.error('PDF split error:', splitErr.message);
      chunks.push(pdfBase64);
    }
 
    console.log(`Processing ${chunks.length} chunk(s)`);
 
    const prompt = `This is a Katana production label PDF. Each page is one label with this structure:
 
[barcode number]
[date]
[quantity] pcs  OR  [length] m
[job reference] - [room/description]
[PRODUCT CODE]
*scan*
 
Extract the PRODUCT CODE and its quantity/length from every page.
 
Rules:
- Output the product code EXACTLY as printed — do not strip, modify, or add any characters
- If the label shows "pcs", output the integer quantity
- If the label shows "m", output the decimal length (e.g. 3.405)
- One line per page: CODE VALUE
- Skip blank pages and the final "Powered by PDF Generator API" page
- No headings, no explanations, just the list
 
Example output:
PMW-TFK 1
PMW-BB 2
PMW-BEP 3
PMW-SB600 2
PJMW-HAMPER45 1
BXPCEN-FIRESTN695 3.405
SHIRT1050 1
T-DT60 1`;
 
    const cabinetCodes = {};
    const benchtopLines = [];
 
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
 
      if (i > 0) {
        console.log('Waiting 30s between chunks for rate limit...');
        await new Promise(r => setTimeout(r, 30000));
      }
 
      const text = await callClaude(chunks[i], prompt);
      if (!text) {
        console.log(`Chunk ${i + 1} returned no text`);
        continue;
      }
 
      text.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;
 
        const parts = line.split(/\s+/);
        if (parts.length < 2) return;
 
        const rawCode = parts[0];
        const val = parseFloat(parts[1]);
 
        if (isNaN(val) || val <= 0) return;
 
        const finalCode = processCode(rawCode);
        if (!finalCode) return;
        if (!finalCode.match(/^[A-Z][A-Z0-9_-]+$/)) return;
 
        if (isBenchtop(finalCode)) {
          benchtopLines.push(`${finalCode} ${val}`);
        } else {
          cabinetCodes[finalCode] = (cabinetCodes[finalCode] || 0) + val;
        }
      });
 
      console.log(`Chunk ${i + 1} done — ${Object.keys(cabinetCodes).length} cabinet/door codes, ${benchtopLines.length} benchtop lines so far`);
    }
 
    const cabinetLines = Object.entries(cabinetCodes).map(([code, val]) => `${code} ${val}`);
    const finalText = [...cabinetLines, ...benchtopLines].join('\n');
 
    console.log(`Done — ${cabinetLines.length} cabinet/door codes, ${benchtopLines.length} benchtop lines`);
    res.json({ codes: finalText });
 
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
}
 
app.listen(PORT, () => console.log(`Amorini PDF server running on port ${PORT}`));
