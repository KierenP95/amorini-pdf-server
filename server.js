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
 
// Cabinet finish prefixes — strip these when the suffix looks like a cabinet code
const CABINET_PREFIXES = [
  'PMW', 'PJMW', 'OLOA', 'ESC', 'EMW', 'OCO', 'ESO', 'ESS',
  'OAO', 'OCW', 'OHO', 'ONB', 'OSPO', 'OMW', 'SMC', 'SMN',
  'SMS', 'PGW', 'PSN', 'SDA', 'ND'
];
 
// Cabinet suffix pattern: starts with 1-2 letters then digits (e.g. SB600, W100S, B45D2PT, WVN90)
// Door suffix pattern: all letters or letters+digits with no leading digit-heavy structure (e.g. TFK, BEP, F409, F45D)
// Rule: if suffix contains digits AND starts with a letter followed eventually by digits → cabinet
// If suffix is all letters OR matches known door patterns → door, keep full code
function processCode(rawCode) {
  const upper = rawCode.toUpperCase();
 
  // Never strip BXP* (benchtops) or DEK* (dekton slabs)
  if (upper.startsWith('BXP') || upper.startsWith('DEK')) return upper;
 
  // Check if it matches a cabinet prefix
  const prefixMatch = upper.match(
    new RegExp(`^(${CABINET_PREFIXES.join('|')})-(.+)$`)
  );
 
  if (!prefixMatch) return upper; // No cabinet prefix — return as-is
 
  const suffix = prefixMatch[2];
 
  // Cabinet suffix: starts with letters, contains digits, e.g. SB600, W100S, B45D2PT, WVN90, P100Z
  // Must have at least one digit somewhere
  const isCabinetSuffix = /^[A-Z]{1,4}\d/.test(suffix);
 
  if (isCabinetSuffix) {
    return suffix; // Strip prefix — it's a cabinet
  } else {
    return upper; // Keep full code — it's a door/panel
  }
}
 
app.post('/extract', async (req, res) => {
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
- Output the product code EXACTLY as printed — do not strip or modify any prefix
- If the label shows "pcs", output the integer quantity
- If the label shows "m", output the decimal length (e.g. 3.405)
- One line per page: CODE VALUE
- Skip blank pages and the final "Powered by PDF Generator API" page
- No headings, no explanations, just the list
 
Example output:
PMW-TFK 1
PMW-BEP 3
PMW-SB600 2
BXPCEN-FIRESTN695 3.405
SHIRT1050 1`;
 
    const allCodes = {};
 
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
 
      if (i > 0) {
        console.log('Waiting 65s for rate limit...');
        await new Promise(r => setTimeout(r, 65000));
      }
 
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
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunks[i] } },
                { type: 'text', text: prompt }
              ]
            }]
          })
        });
 
        const data = await response.json();
        if (data.error) {
          console.error('Claude error:', data.error);
          continue;
        }
 
        const text = data.content?.find(b => b.type === 'text')?.text?.trim();
        if (!text) continue;
 
        text.split('\n').forEach(line => {
          line = line.trim();
          if (!line) return;
 
          const parts = line.split(/\s+/);
          if (parts.length < 2) return;
 
          const rawCode = parts[0];
          const val = parseFloat(parts[1]);
 
          if (isNaN(val) || val <= 0) return;
 
          // Process code — strips cabinet prefixes, keeps door/benchtop codes intact
          const finalCode = processCode(rawCode);
 
          if (!finalCode.match(/^[A-Z][A-Z0-9_-]+$/)) return;
 
          allCodes[finalCode] = (allCodes[finalCode] || 0) + val;
        });
 
        console.log(`Chunk ${i + 1} processed — ${Object.keys(allCodes).length} unique codes so far`);
 
      } catch (err) {
        console.error(`Chunk ${i + 1} error:`, err.message);
      }
    }
 
    const finalText = Object.entries(allCodes)
      .map(([code, val]) => `${code} ${val}`)
      .join('\n');
 
    console.log(`Done — ${Object.keys(allCodes).length} total unique codes`);
    res.json({ codes: finalText });
 
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});
 
app.listen(PORT, () => console.log(`Amorini PDF server running on port ${PORT}`));
