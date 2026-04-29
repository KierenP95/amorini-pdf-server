const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { PDFDocument } = require('pdf-lib');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
// Allow requests from your Netlify site
app.use(cors({
  origin: ['https://amorinilogisticsinterstatebookings.netlify.app', 'http://localhost:3000']
}));
 
app.use(express.json({ limit: '50mb' }));
 
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
app.post('/extract', async (req, res) => {
  try {
    const { pdfBase64 } = req.body;
 
    if (!pdfBase64) return res.status(400).json({ error: 'No PDF data received' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
 
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
 
    // Split PDF into chunks of 40 pages
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
          const copiedPages = await subDoc.copyPagesFrom(pdfDoc, indices);
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
 
    const prompt = `Extract ALL product codes from this Katana label PDF. Process every single page.
 
Each page has this structure:
[barcode number]
[date]
[qty] pcs or [length] m
[job ref] - [description]
[PRODUCT CODE]
*scan*
 
Extract the PRODUCT CODE and quantity/length from every page.
 
Rules by product type:
 
CABINETS (prefix PMW-, OLOA-, PJMW-, ESC-, EMW-, OCO-, ESO-, ESS-, OAO-, OCW-, OHO-, ONB-, OSPO-, OMW-, SMC-, SMN-, SMS-, PGW-, PSN-, SDA- AND the part after the prefix looks like a cabinet code — letters followed by numbers, e.g. SB100, WBO900, B600):
- Strip the prefix, output just the cabinet code + qty
- Example: PMW-SB600 1 → SB600 1
 
DOORS & PANELS (prefix PMW-, PJMW- etc BUT the part after the prefix is NOT a cabinet code — it's an abbreviation like TFK, BEP, SFP, WEP, UP, BB, FP, F409, F40Z, F45D, F454 etc):
- Keep the FULL code including prefix
- Example: PMW-TFK 1 → PMW-TFK 1
- Example: PJMW-F454 1 → PJMW-F454 1
 
BENCHTOPS linear metre (prefix BXP-, has metres on label):
- Keep full code + length in metres
- Example: BXPCEN-FIRESTN695 3.405 → BXPCEN-FIRESTN695 3.405
 
BENCHTOPS slab (format COLOUR-DIMENSIONS, has pcs):
- Keep full code + qty
- Example: ALPINE-3050900 2 → ALPINE-3050900 2
 
WARDROBE COMPONENTS (prefix T-, SHIRT, codes like SHIRT1050, T-DT60, T-CLEAT41795, T-SHELF1245, T-UPRIGHT1945):
- Keep full code + qty
- Example: SHIRT1050 3 → SHIRT1050 3
 
HARDWARE & OTHER (codes like IADJL, KTDRW45-SC, D500, DRILLINPUSHCATCH, BXPLAMVOLCBLK60):
- Keep full code + qty
 
EXCLUDE entirely: DW605, FLUPANEL, Custom_* codes
 
Output one line per unique code: CODE VALUE
No explanations. No headings. Just the list.`;
 
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
 
        // Codes to exclude entirely
        const excluded = new Set(['DW605', 'FLUPANEL']);
 
        text.split('\n').forEach(line => {
          line = line.trim();
          if (!line || line.startsWith('#') || line.startsWith('*') || line.startsWith('Custom_')) return;
 
          const parts = line.split(/\s+/);
          const code = parts[0].toUpperCase();
          const val = parseFloat(parts[1]);
 
          if (!code || isNaN(val)) return;
          if (excluded.has(code)) return;
          if (code.startsWith('CUSTOM_')) return;
 
          // Validate code format — must contain at least one letter
          if (!code.match(/^[A-Z][A-Z0-9_-]*$/)) return;
 
          allCodes[code] = (allCodes[code] || 0) + val;
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
