// Regenerate icon.jpg (the file `@nx.js/nro` reads at the project root for
// the homebrew launcher icon) from the canonical PNG logo under
// romfs/assets/. Switch NRO icons are 256×256 JPEG; we resize and re-
// encode with System.Drawing via PowerShell so no extra npm dep is
// needed. Re-runs only when the source PNG is newer than the JPEG.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'romfs', 'assets', 'SwitchSurf_logo.png');
const dst = join(root, 'icon.jpg');

if (!existsSync(src)) {
	console.error(`build-icon: source not found at ${src}`);
	process.exit(1);
}

if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) {
	console.log(`build-icon: icon.jpg up to date (source unchanged)`);
	process.exit(0);
}

const psQuote = (p) => `'${p.replace(/'/g, "''")}'`;
const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = ${psQuote(src)}
$dst = ${psQuote(dst)}
$img = [System.Drawing.Image]::FromFile($src)
try {
	$bmp = New-Object System.Drawing.Bitmap 256, 256
	try {
		$g = [System.Drawing.Graphics]::FromImage($bmp)
		try {
			$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
			$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
			$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
			$g.DrawImage($img, 0, 0, 256, 256)
		} finally { $g.Dispose() }
		$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
		$params = New-Object System.Drawing.Imaging.EncoderParameters 1
		$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 90L
		$bmp.Save($dst, $enc, $params)
	} finally { $bmp.Dispose() }
} finally { $img.Dispose() }
`;

execFileSync(
	'powershell',
	['-NoProfile', '-NonInteractive', '-Command', psScript],
	{ stdio: 'inherit' },
);

const bytes = statSync(dst).size;
console.log(`build-icon: wrote ${dst} (${(bytes / 1024).toFixed(1)} KB, 256×256 JPEG)`);
