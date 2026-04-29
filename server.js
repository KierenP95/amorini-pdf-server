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
      // Fall back to single chunk — will fail if over 100 pages
      chunks.push(pdfBase64);
    }
 
    console.log(`Processing ${chunks.length} chunk(s)`);
 
    const prompt = `Extract ALL product codes from this Katana label PDF. Process every single page.
 
This PDF may contain cabinets, benchtops and doors/panels mixed together.
 
For each page output one line: CODE VALUE where:
- Cabinets (prefix PMW-, OLOA-, PJMW- etc): strip prefix, output CODE QTY e.g. SB100 1
- Benchtops M2M (prefix BXP-, has metres on label): keep full code, output CODE LENGTH e.g. BXPMIR-WARMGREY60 2.42
- Benchtops slab (format COLOUR-DIMENSIONS, has pcs): keep full code, output CODE QTY e.g. ALPINE-3050900 2
- Doors/panels (all other codes): keep full code, output CODE QTY e.g. PMW-BB 4
 
EXCLUDE: DW605, TFK, TFK_, UP, F409, FLUPANEL.
INCLUDE: UBMWHT, UBMWH, UBO60, UBO90.
 
No explanations. No headings. Just the list.`;
 
    // Process chunks with delay between them
    const allCodes = {};
 
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
 
      // Wait 65 seconds between chunks to stay under rate limit
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
 
        // Parse and merge results
        const excluded = new Set(['DW605', 'TFK', 'TFK_', 'UP', 'F409', 'FLUPANEL']);
        text.split('\n').forEach(line => {
          line = line.trim();
          if (!line || line.startsWith('#') || line.startsWith('*')) return;
          const parts = line.split(/\s+/);
          const code = parts[0].toUpperCase();
          const val = parseFloat(parts[1]);
          if (!code || !code.match(/^[A-Z][A-Z0-9_-]+$/) || isNaN(val)) return;
          if (excluded.has(code)) return;
          // Strip cabinet finish prefixes (PMW-, OLOA-, PJMW- etc) but keep benchtop/door prefixes
          let finalCode = code;
          const cabinetPrefixMatch = code.match(/^(PMW|OLOA|PJMW|ESC|EMW|OCO|ESO|ESS|OAO|OCW|OHO|ONB|OSPO|OMW|SMC|SMN|SMS|PGW|PSN|SDA)-(.+)$/);
          // Only strip prefix if remaining part looks like a cabinet code (starts with B,W,T,P,S,U)
          // Keep full code for benchtops (BXP-) and DEK- slabs
          if (cabinetPrefixMatch && !code.startsWith('BXP') && !code.startsWith('DEK')) {
            finalCode = cabinetPrefixMatch[2];
          }
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
