# dev/make-orion-assets.ps1 - turn the supplied Orion PNG into the web assets.
#
# The source has an opaque #f7f7f7 background and a lot of empty margin. This
# script floods that background to transparency from the border (so white
# highlights inside the art survive), crops to the artwork, and renders the
# square favicon / home-screen icons on the dashboard's yellow with a black
# border.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File dev\make-orion-assets.ps1 `
#     -Source "C:\path\to\orion.png"
#
# Only the generated files are committed; the source stays outside the repo.

param(
  [Parameter(Mandatory = $true)][string]$Source
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class OrionAssets
{
    private static bool Near(byte b, byte g, byte r, byte bb, byte bg, byte br, int tol)
    {
        return Math.Abs(b - bb) <= tol && Math.Abs(g - bg) <= tol && Math.Abs(r - br) <= tol;
    }

    // Flood the near-background colour from every border pixel to alpha 0,
    // then crop to the pixels that remain. Returns the transparent artwork.
    public static Bitmap Cutout(string srcPath, int pad)
    {
        using (var src = new Bitmap(srcPath))
        {
            int w = src.Width, h = src.Height;
            var rect = new Rectangle(0, 0, w, h);
            var data = src.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            var buf = new byte[stride * h];
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);

            // Memory order for 32bppArgb is B, G, R, A.
            byte bb = buf[0], bg = buf[1], br = buf[2];
            int tol = 20;
            var seen = new bool[w * h];
            var stack = new int[w * h];
            int sp = 0;

            Action<int, int> push = (x, y) => {
                int i = y * w + x;
                if (seen[i]) return;
                int o = y * stride + x * 4;
                if (!Near(buf[o], buf[o + 1], buf[o + 2], bb, bg, br, tol)) return;
                seen[i] = true;
                stack[sp++] = i;
            };

            for (int x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
            for (int y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

            while (sp > 0)
            {
                int i = stack[--sp];
                int y = i / w, x = i % w;
                int o = y * stride + x * 4;
                buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
                if (x > 0) push(x - 1, y);
                if (x < w - 1) push(x + 1, y);
                if (y > 0) push(x, y - 1);
                if (y < h - 1) push(x, y + 1);
            }

            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int row = y * stride;
                for (int x = 0; x < w; x++)
                {
                    if (buf[row + x * 4 + 3] == 0) continue;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }

            Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            src.UnlockBits(data);

            if (maxX < 0) throw new Exception("the source is entirely background");

            int left = Math.Max(0, minX - pad);
            int top = Math.Max(0, minY - pad);
            int right = Math.Min(w - 1, maxX + pad);
            int bottom = Math.Min(h - 1, maxY + pad);
            var crop = new Rectangle(left, top, right - left + 1, bottom - top + 1);
            return src.Clone(crop, PixelFormat.Format32bppArgb);
        }
    }

    // Square icon: yellow field, hard black border, artwork centred and fitted.
    public static void Icon(Bitmap art, string path, int size)
    {
        using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.FromArgb(255, 255, 230, 0));
            g.SmoothingMode = SmoothingMode.None;
            float bw = Math.Max(2f, size / 14f);
            using (var pen = new Pen(Color.Black, bw))
                g.DrawRectangle(pen, bw / 2f, bw / 2f, size - bw, size - bw);

            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float inner = size - 2f * bw - size * 0.14f;
            float scale = Math.Min(inner / art.Width, inner / art.Height);
            float dw = art.Width * scale, dh = art.Height * scale;
            g.DrawImage(art, (size - dw) / 2f, (size - dh) / 2f, dw, dh);

            bmp.Save(path, ImageFormat.Png);
        }
    }
}
'@

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'web\assets'
$icons = Join-Path $root 'web\icons'
New-Item -ItemType Directory -Force -Path $assets, $icons | Out-Null

$art = [OrionAssets]::Cutout((Resolve-Path $Source).Path, 10)
try {
  $artPath = Join-Path $assets 'orion.png'
  $art.Save($artPath, [System.Drawing.Imaging.ImageFormat]::Png)
  "wrote $artPath ($($art.Width)x$($art.Height))"

  foreach ($size in 32, 48, 64, 180, 192, 512) {
    $path = Join-Path $icons "orion-$size.png"
    [OrionAssets]::Icon($art, $path, $size)
    "wrote $path"
  }
}
finally {
  $art.Dispose()
}
