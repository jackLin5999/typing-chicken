const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "..", "src-tauri", "icons");

// ── Chicken SVG design ──────────────────────────────────────────────────────
function chickenSvg(size) {
  const s = size;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${s}" height="${s}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bodyGrad" cx="50%" cy="45%" r="50%">
      <stop offset="0%" stop-color="#FFF5E0"/>
      <stop offset="100%" stop-color="#F5D79E"/>
    </radialGradient>
    <radialGradient id="combGrad" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="#FF4444"/>
      <stop offset="100%" stop-color="#CC0000"/>
    </radialGradient>
  </defs>
  <circle cx="256" cy="256" r="240" fill="#FFE4B5" stroke="#E8C56D" stroke-width="6"/>
  <ellipse cx="256" cy="310" rx="145" ry="125" fill="url(#bodyGrad)" stroke="#E8C56D" stroke-width="4"/>
  <g fill="url(#combGrad)" stroke="#AA0000" stroke-width="2">
    <ellipse cx="240" cy="155" rx="22" ry="30"/>
    <ellipse cx="275" cy="145" rx="22" ry="32"/>
    <ellipse cx="310" cy="152" rx="22" ry="28"/>
  </g>
  <circle cx="295" cy="210" r="22" fill="white" stroke="#333" stroke-width="3"/>
  <circle cx="300" cy="208" r="11" fill="#222"/>
  <circle cx="305" cy="204" r="4" fill="white"/>
  <polygon points="325,225 360,235 325,245" fill="#FF8C00" stroke="#CC6600" stroke-width="2"/>
  <ellipse cx="310" cy="260" rx="12" ry="18" fill="#FF4444" stroke="#CC0000" stroke-width="2"/>
  <ellipse cx="200" cy="290" rx="55" ry="75" fill="#F5D79E" stroke="#E0C070" stroke-width="2" transform="rotate(-10,200,290)"/>
  <g fill="none" stroke-width="5">
    <path d="M115,270 Q60,200 70,160" stroke="#E8C56D"/>
    <path d="M118,285 Q55,230 50,180" stroke="#F0D080"/>
    <path d="M120,300 Q55,260 45,210" stroke="#E8C56D"/>
    <path d="M118,315 Q60,290 55,245" stroke="#D4A84B"/>
    <path d="M115,330 Q65,320 70,280" stroke="#E8C56D"/>
  </g>
  <g stroke="#FF8C00" stroke-width="8" stroke-linecap="round">
    <line x1="220" y1="430" x2="210" y2="490"/>
    <line x1="280" y1="430" x2="290" y2="490"/>
  </g>
  <g fill="#FF8C00" stroke="#E07800" stroke-width="3">
    <path d="M210,490 L185,505 M210,490 L210,508 M210,490 L235,505"/>
    <path d="M290,490 L265,505 M290,490 L290,508 M290,490 L315,505"/>
  </g>
</svg>`;
}

async function generatePng(size) {
  return sharp(Buffer.from(chickenSvg(size))).png().toBuffer();
}

// Generate DIB (device-independent bitmap) for ICO — fully manual from raw RGBA
async function generateDib(size) {
  const { data, info } = await sharp(Buffer.from(chickenSvg(size)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // data is raw RGBA, top-to-bottom rows
  const width = info.width;
  const height = info.height;

  // ICO DIB expects BGRA, bottom-to-top rows, height*2 for XOR+AND mask
  const rowSize = width * 4; // BGRA = 4 bytes
  const andMaskRowSize = Math.ceil(width / 8); // 1 bit per pixel, padded to 4 bytes
  // Make AND mask row size multiple of 4
  const andMaskPaddedRowSize = Math.ceil(andMaskRowSize / 4) * 4;

  // Convert RGBA (top-to-bottom) → BGRA (bottom-to-top)
  const xorRows = [];
  for (let y = height - 1; y >= 0; y--) {
    const row = Buffer.alloc(rowSize);
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * 4;
      const dstOff = x * 4;
      row[dstOff] = data[srcOff + 2];     // B ← R
      row[dstOff + 1] = data[srcOff + 1]; // G ← G
      row[dstOff + 2] = data[srcOff];     // R ← B
      row[dstOff + 3] = data[srcOff + 3]; // A ← A
    }
    xorRows.push(row);
  }

  // AND mask: all zeros (transparent) for 32-bit
  const andMaskRows = [];
  for (let y = 0; y < height; y++) {
    andMaskRows.push(Buffer.alloc(andMaskPaddedRowSize, 0));
  }

  // BITMAPINFOHEADER (40 bytes)
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);              // biSize
  dib.writeInt32LE(width, 4);            // biWidth
  dib.writeInt32LE(height * 2, 8);       // biHeight (XOR + AND masks)
  dib.writeUInt16LE(1, 12);              // biPlanes
  dib.writeUInt16LE(32, 14);             // biBitCount (32-bit BGRA)
  dib.writeUInt32LE(0, 16);              // biCompression (BI_RGB)
  dib.writeUInt32LE(0, 20);              // biSizeImage (can be 0 for BI_RGB)
  dib.writeInt32LE(0, 24);               // biXPelsPerMeter
  dib.writeInt32LE(0, 28);               // biYPelsPerMeter
  dib.writeUInt32LE(0, 32);              // biClrUsed
  dib.writeUInt32LE(0, 36);              // biClrImportant

  return Buffer.concat([dib, ...xorRows, ...andMaskRows]);
}

const squareSizes = [30, 44, 71, 89, 107, 142, 150, 284, 310, 50];
const standardSizes = [32, 64, 128, 256];

async function generateIcons() {
  // Standard PNG icons
  for (const size of standardSizes) {
    const buf = await generatePng(size);
    const fname = size === 256 ? "128x128@2x.png" : `${size}x${size}.png`;
    fs.writeFileSync(path.join(ICONS_DIR, fname), buf);
    console.log(`  ✓ ${fname}`);
  }

  // Square PNG icons
  for (const size of squareSizes) {
    const buf = await generatePng(size);
    const fname = size === 50 ? "StoreLogo.png" : `Square${size}x${size}Logo.png`;
    fs.writeFileSync(path.join(ICONS_DIR, fname), buf);
    console.log(`  ✓ ${fname}`);
  }

  // icon.png (512×512)
  const png512 = await generatePng(512);
  fs.writeFileSync(path.join(ICONS_DIR, "icon.png"), png512);
  console.log("  ✓ icon.png (512×512)");

  // icon.ico — DIB-based (most compatible)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const dibs = [];
  for (const size of icoSizes) {
    dibs.push(await generateDib(size));
  }

  // Build ICO
  const headerSize = 6;
  const dirEntrySize = 16;
  let dataOffset = headerSize + icoSizes.length * dirEntrySize;

  const entries = [];
  for (let i = 0; i < icoSizes.length; i++) {
    entries.push({ w: icoSizes[i], h: icoSizes[i], dib: dibs[i], offset: dataOffset });
    dataOffset += dibs[i].length;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(icoSizes.length, 4);

  const dir = Buffer.alloc(icoSizes.length * dirEntrySize);
  entries.forEach((e, i) => {
    const o = i * dirEntrySize;
    const sz = e.w >= 256 ? 0 : e.w;
    dir.writeUInt8(sz, o);
    dir.writeUInt8(sz, o + 1);
    dir.writeUInt8(0, o + 2);   // palette
    dir.writeUInt8(0, o + 3);   // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.dib.length, o + 8);
    dir.writeUInt32LE(e.offset, o + 12);
  });

  const icoBuf = Buffer.concat([header, dir, ...entries.map((e) => e.dib)]);
  fs.writeFileSync(path.join(ICONS_DIR, "icon.ico"), icoBuf);
  console.log(`\n  ✓ icon.ico (DIB, sizes: ${icoSizes.join(",")}) — ${icoBuf.length} bytes`);

  console.log("\n✅ All chicken icons generated in", ICONS_DIR);
}

generateIcons().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
