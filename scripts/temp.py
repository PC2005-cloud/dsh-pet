from PIL import Image

def remove_white_background(input_img, output_png, threshold=240):
    im = Image.open(input_img).convert("RGBA")
    pixdata = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixdata[x, y]
            # 白色判定：RGB都大于阈值就透明
            if g==0xff :
                pixdata[x, y] = (r, g, b, 0)
    im.save(output_png)
    print("完成！输出透明png：", output_png)

# =========改这两个文件名=========
remove_white_background("logo.png", "out.png")