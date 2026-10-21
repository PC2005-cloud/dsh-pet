# 弹弓小互动 · 美术素材

桌面宠物右键「弹弓」打开的小互动只用位图素材，全部在 `runtime/electron-helper/game-assets/`。
这里记录每张图从哪来、按什么规格做、怎么重新生成。

## 原则

- **宠物本身不另画**：宠物在弹弓里、被拽、飞、跑、欢呼，用的都是她自己的 webm 动画（`assets/webm`），与桌面上是同一套。
- **能从原画里取的就取**：瞄准 / 拖尾用的小泡泡直接抠自宠物自己的动画帧，笔触、透明度、光感与角色完全一致。
- **原画里没有的才绘制**：弹弓、皮筋、皮兜、接地影子、木箱、裂纹、碎木片、木屑按下面的规格离线绘制成位图（共用 `artlib.py` 的调色板 / 光照 / 线条参数）。
- 画面里没有任何用几何图形、渐变圆、emoji 或字符冒充的美术。唯一在运行时变形的是皮筋：它本来就要随拉伸变形，所以是把 `band.png` 沿两点拉伸贴上去。

## 规格（对齐宠物原画）

| 项目 | 规格                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 线条 | 细线，深色。角色主线是 rgb(21,27,35) 的深藏青，木头用对应的暖深棕 rgb(52,33,24)；背光一侧略粗，像笔刷                                                                          |
| 光照 | 光源在左上（与角色一致）。一层阴影、软边缘，加一道很淡的高光，暗部边缘带一点反光                                                                                               |
| 颜色 | 低饱和、偏暖的木色和皮革色。不用高饱和金色，不加外发光，不加厚描边                                                                                                             |
| 质感 | 木纹是低对比的纵向纹理（每条板子顺着自己的方向），弹弓有一个淡淡的木节、叉尖缠皮绳，皮兜带缝线；木箱由一块块木板拼成：外框、三条内板、一根斜撑（在内板上投下柔和的影子）和钉子 |
| 密度 | 3 px / 场景逻辑像素。1080p 屏上窗口约 1.5×，高 DPI 屏上依然清晰                                                                                                                |
| 背景 | 全部是透明 PNG，窗口本身也是透明的                                                                                                                                             |

## 文件

| 文件                                       | 来源                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `bubble-s1~s3`                             | 抠自「鲸鱼吐泡泡特效」4.8–5.7 秒的帧，`cut-props.py`                     |
| `sling.png`、`sling.json`、`sling-meta.js` | 绘制，`paint-slingshot.py`（叉尖坐标写进元数据，代码里的叉高有单测对照） |
| `band.png`、`pouch.png`、`shadow.png`      | 绘制，`paint-slingshot.py`                                               |
| `crate.png`、`crate-cracked.png`           | 绘制，`paint-crates.py`（54 逻辑单位的方木箱）                           |
| `shard-1~3.png`、`dust.png`                | 绘制，`paint-crates.py`（木箱碎开时的木片与木屑）                        |

刚体物理用的是 matter-js（MIT，devDependency 固定 0.20.0）：`scripts/build-desktop-core.mjs` 把它的浏览器构建和许可证全文拷到 `runtime/electron-helper/vendor/`。

## 重新生成

```sh
# 绘制的部分（弹弓 / 皮筋 / 皮兜 / 影子 + 元数据；木箱 / 碎片 / 木屑）
python -I scripts/game-art/paint-slingshot.py runtime/electron-helper/game-assets
python -I scripts/game-art/paint-crates.py runtime/electron-helper/game-assets
```

```sh
# 抠图的部分：先把需要的帧导出成带 alpha 的 PNG，再抠
python -I scripts/game-art/cut-props.py <帧目录> runtime/electron-helper/game-assets
```

导出帧要用浏览器。素材是 VP9 带 alpha 的 webm，常见的 OpenCV / ffmpeg 构建缺 libvpx，会把 alpha 通道丢掉。
在 Chromium 里把 webm 取成 blob（这样才能精确 seek），seek 到指定秒数，画到 canvas 上再 `toBlob('image/png')`，
文件命名为 `<动画名>_<秒数>.png`（例如 `鲸鱼吐泡泡特效_4.20.png`）。需要哪些帧见 `cut-props.py` 里的 `PROPS` 表。
