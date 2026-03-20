// Generates web/icon-192.png and web/icon-512.png from web/icon.svg
// Run with: node gen-icons.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const svgPath = path.join(__dirname, 'web', 'icon.svg');
const svg = fs.readFileSync(svgPath);

async function main() {
  const { Resvg } = await import('@resvg/resvg-js');

  for (const size of [192, 512]) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
    });
    const png = resvg.render().asPng();
    const out = path.join(__dirname, 'web', `icon-${size}.png`);
    fs.writeFileSync(out, png);
    console.log(`✓ ${out}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
