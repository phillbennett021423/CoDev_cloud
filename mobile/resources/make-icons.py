# Regenerates the Android launcher icons from icon-source.jpg.
# Usage (from mobile/): python3 resources/make-icons.py resources/icon-source.jpg android/app/src/main/res preview.png
import sys
from PIL import Image, ImageDraw, ImageFilter
src, res = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
X0, Y0, S = 219, 220, 586                      # rounded square in the source image
sq = im.crop((X0, Y0, X0 + S, Y0 + S))
px = sq.load()
i = int(S * 0.15)
c = [px[i, i], px[S - i, i], px[i, S - i], px[S - i, S - i]]   # TL TR BL BR
def gradient(n):
    g = Image.new('RGB', (n, n)); gp = g.load()
    for y in range(n):
        v = y / (n - 1)
        for x in range(n):
            u = x / (n - 1)
            gp[x, y] = tuple(int((c[0][k]*(1-u)+c[1][k]*u)*(1-v) + (c[2][k]*(1-u)+c[3][k]*u)*v) for k in range(3))
    return g
def rr_mask(n, r, inset=0):
    m = Image.new('L', (n*4, n*4), 0)
    ImageDraw.Draw(m).rounded_rectangle((inset*4, inset*4, (n-inset)*4-1, (n-inset)*4-1), r*4, fill=255)
    return m.resize((n, n), Image.LANCZOS)
BIG = 1296                                    # 108dp at 12x
canvas = gradient(BIG)
side = int(BIG * 0.74)
tile = sq.resize((side, side), Image.LANCZOS)
off = (BIG - side) // 2
canvas.paste(tile, (off, off), rr_mask(side, int(side*0.17), 2).filter(ImageFilter.GaussianBlur(3)))
for d, f in {'mdpi':1, 'hdpi':1.5, 'xhdpi':2, 'xxhdpi':3, 'xxxhdpi':4}.items():
    canvas.resize((int(108*f),)*2, Image.LANCZOS).save(f'{res}/mipmap-{d}/ic_launcher_foreground.png', optimize=True)
    n = int(48*f)
    t = sq.resize((n, n), Image.LANCZOS).convert('RGBA')
    t.putalpha(rr_mask(n, int(n*0.17), max(1, n//48)))
    t.save(f'{res}/mipmap-{d}/ic_launcher.png', optimize=True)
    r = sq.resize((n, n), Image.LANCZOS).convert('RGBA')
    m = Image.new('L', (n*4, n*4), 0); ImageDraw.Draw(m).ellipse((n//12*4, n//12*4, (n-n//12)*4-1, (n-n//12)*4-1), fill=255)
    r.putalpha(m.resize((n, n), Image.LANCZOS)); r.save(f'{res}/mipmap-{d}/ic_launcher_round.png', optimize=True)
print('bg', '#%02X%02X%02X' % tuple(sum(cc[k] for cc in c)//4 for k in range(3)))
# preview: adaptive icon under circle and squircle masks
p = Image.new('RGB', (900, 330), (240, 240, 240))
fg = canvas.resize((324, 324), Image.LANCZOS)
vis = fg.crop((54, 54, 270, 270))
m1 = Image.new('L', (216, 216), 0); ImageDraw.Draw(m1).ellipse((0, 0, 215, 215), fill=255)
p.paste(vis, (40, 57), m1); p.paste(vis, (330, 57), rr_mask(216, 50))
p.paste(Image.open(f'{res}/mipmap-xxxhdpi/ic_launcher.png'), (640, 69), Image.open(f'{res}/mipmap-xxxhdpi/ic_launcher.png'))
p.save(sys.argv[3])
