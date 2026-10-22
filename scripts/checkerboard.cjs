'use strict'
const sharp = require('sharp')

const src = process.argv[2]
const out = process.argv[3]

;(async () => {
  const m = await sharp(src).metadata()
  const t = 32
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">
    <defs><pattern id="c" width="${t * 2}" height="${t * 2}" patternUnits="userSpaceOnUse">
      <rect width="${t * 2}" height="${t * 2}" fill="#ffffff"/>
      <rect width="${t}" height="${t}" fill="#d8dbe3"/>
      <rect x="${t}" y="${t}" width="${t}" height="${t}" fill="#d8dbe3"/>
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#c)"/></svg>`
  await sharp(Buffer.from(svg)).composite([{ input: src }]).png().toFile(out)
  console.log('saved ' + out)
})()
