/**
 * 浏览器侧截屏：抓一帧桌面，立刻停流，再交给同一套预算编码。
 *
 * 只抓一帧、不保留流；用户取消选择或页面策略禁止 display-capture 时抛错，
 * 由弹窗把原因显示出来（浏览器不允许时只能改用上传）。
 * @module dsh-pet/src/shared/chat/capture
 */
import { uiT } from '../ui/i18n.ts';
import { type EncodedImage, encodeCanvas } from './encode.ts';

/** 等到视频真正有尺寸。 */
function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    video.onloadeddata = () => resolve();
  });
}

/**
 * 截取当前屏幕的一帧。
 *
 * @returns 已压进预算的图片。
 * @throws 环境不支持、用户取消或页面策略禁止 display-capture 时。
 */
export async function captureDisplayFrame(): Promise<EncodedImage> {
  const media = navigator.mediaDevices;
  if (!media || typeof media.getDisplayMedia !== 'function') throw new Error(uiT('chat.captureUnavailable'));
  const stream = await media.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await waitForFrame(video);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return encodeCanvas(canvas);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
