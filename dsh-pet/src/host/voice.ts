/**
 * 语音播报（可选）：把桌宠刚说的话用系统 TTS 念出来。
 *
 * 只在 macOS 上生效（系统自带 `say`）；其他平台 {@link speak} 直接返回，不报错、不引入依赖。
 * 设计：
 *  - 无第三方依赖、不阻塞生成链路：串行队列 + 排队上限 + 单句超时；
 *  - 文本先清洗再截断，避免把 Markdown / 链接 / 配图标记念出来；
 *  - 失败静默：语音是增强，不能反过来影响对话与碎碎念。
 * @module dsh-pet/src/host/voice
 */
import { spawn } from 'node:child_process';

/** 单次最多念多少字：回复本身不超过 256 token，再长也没人听完 */
const MAX_CHARS = 200;
/** 单句播放超时（毫秒）：`say` 卡住不能拖住队列 */
const TIMEOUT_MS = 15_000;
/** 同时排队的上限：连续对话时不叠音 */
const MAX_PENDING = 2;

let queue: Promise<void> = Promise.resolve();
let pending = 0;

/**
 * 把要念的文本洗成纯口语：去代码块、行内代码、链接、配图标记，压缩空白后截断。
 * 导出为纯函数是为了单测（不依赖麦克风/扬声器）。
 */
export function cleanSpeech(raw: unknown): string {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[图:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

/**
 * 当前平台可用的 TTS 命令（不含要念的文本）。
 * 目前只实现 macOS；返回 undefined = 该平台不播报。
 * @param platform - 可注入，便于单测在任意平台验证分支
 */
export function ttsCommand(platform: NodeJS.Platform = process.platform): string[] | undefined {
  if (platform === 'darwin') return ['say'];
  return undefined;
}

/** 念一句。失败/不支持/排队已满都静默返回，调用方不需要 await。 */
export function speak(raw: unknown): void {
  const cmd = ttsCommand();
  if (!cmd) return;
  const text = cleanSpeech(raw);
  if (!text) return;
  if (pending >= MAX_PENDING) return;
  pending += 1;
  queue = queue
    .then(() => play(cmd, text))
    .catch(() => {
      /* play 自身不会抛；兜底防队列中断 */
    })
    .then(() => {
      pending -= 1;
    });
}

/** 起一个播放进程，等它退出或超时；无论哪种结果都 resolve，绝不 reject。 */
function play(cmd: string[], text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const child = spawn(cmd[0], [...cmd.slice(1), text], { stdio: 'ignore' });
      child.on('close', done);
      child.on('error', done);
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 进程已经退出 */
        }
        done();
      }, TIMEOUT_MS).unref();
    } catch {
      done();
    }
  });
}
