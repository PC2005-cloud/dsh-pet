/**
 * 宠物视频帧的「alpha 去噪」（经典 script，暴露 window.PetFrameFilter；只被 game.js 用）。
 *
 * 为什么要有：宠物 webm 的 alpha 通道整帧都带一点点噪声（1~7/255）。<video> 直接上屏时看不出，
 * 画进 canvas 却会在宠物四周留下一层淡淡的方框底——浅色桌面上能看见一个框。
 * 做法：每帧把视频上传成 WebGL 纹理，片元着色器把 alpha 低于 FLOOR 的压成 0、其余线性拉回 [0, 1]，
 * 再把这块小画布交给 2D canvas 画。全程在 GPU 上，比 canvas 的 url(#svg) 滤镜快得多（后者实测掉一半帧率）。
 * WebGL 不可用 / 上下文丢失 / 上传失败（例如视频还没有帧）时原样返回视频帧，画面照常，只是没去噪。
 */
'use strict';

const PetFrameFilter = (() => {
  /** alpha 低于它（约 12/255）一律当成透明 */
  const FLOOR = 0.05;

  const VERT = `
    attribute vec2 p;
    varying vec2 uv;
    void main() {
      uv = p * 0.5 + 0.5;
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const FRAG = `
    precision mediump float;
    uniform sampler2D frame;
    uniform float floorA;
    varying vec2 uv;
    void main() {
      vec4 c = texture2D(frame, uv);
      float a = clamp((c.a - floorA) / (1.0 - floorA), 0.0, 1.0);
      gl_FragColor = vec4(c.rgb * a, a);
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    return sh;
  }

  /** 建好 GL 管线；失败返回 null（调用方退回直接画视频帧） */
  function setup(canvas) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 着色器拿到的是「未预乘」的颜色（自己按新 alpha 预乘输出），并把视频的上下翻成 GL 的纹理坐标
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1f(gl.getUniformLocation(prog, 'floorA'), FLOOR);
    gl.clearColor(0, 0, 0, 0);
    return gl;
  }

  /** 一个过滤器实例：apply(video) → 去过噪的画布（可直接 drawImage），不可用时返回 video 本身 */
  function create() {
    const canvas = document.createElement('canvas');
    let gl = null;
    try {
      gl = setup(canvas);
    } catch (e) {
      console.error('[dsh-pet slingshot] 宠物帧去噪不可用，直接画视频帧：', e);
    }
    let broken = !gl;
    return {
      apply(video) {
        // GPU 重置 / 休眠唤醒会丢 WebGL 上下文：之后的 gl 调用静默失效、画出来是空的——丢了就直接画视频帧
        if (broken || gl.isContextLost() || !video.videoWidth || !video.videoHeight) return video;
        try {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          return canvas;
        } catch (e) {
          broken = true; // 只报一次：之后一直直接画视频帧
          console.error('[dsh-pet slingshot] 宠物帧去噪失败，改为直接画视频帧：', e);
          return video;
        }
      },
    };
  }

  return { create, FLOOR };
})();

if (typeof window !== 'undefined') window.PetFrameFilter = PetFrameFilter;
