/**
 * 头像片段的契约测试：跑的是生成出来的那段脚本，不是源码文本。
 *
 * 用 vm 提供最小 DOM 替身（make/FileReader/canvas/createImageBitmap/URL），断言「请求了什么、发到哪、失败怎么显示」。
 * 头像不能直接塞进 img src（同源 img 不带 Origin 会被判成文件来源），所以这里也钉住「先带令牌 fetch 再转 blob」。
 * 跑法：node --experimental-strip-types --test src/standalone/settings-page/script/avatar.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { AVATAR_MAX_SIDE_PX as CLIENT_AVATAR_MAX_SIDE_PX } from '../../../client/settings/avatar-upload.ts';
import { AVATAR_MAX_SIDE_PX } from '../../settings-page.ts';
import { avatarScript } from './avatar.ts';

const LOGO = '/dsh-pet-7340/logo';
const API = '/dsh-pet-7340';

type FakeNode = {
  tag: string;
  props: Record<string, unknown>;
  children: FakeNode[];
  listeners: Record<string, (event?: unknown) => void>;
  textContent: string;
  dataset: Record<string, string>;
  src: string;
  value: string;
  files: unknown[];
  hidden: boolean;
  append(...kids: FakeNode[]): void;
  addEventListener(name: string, fn: (event?: unknown) => void): void;
  setAttribute(name: string, value: string): void;
  click(): void;
};

/** 与页面里的 make 同语义的最小替身：只实现这个片段用到的属性。 */
function make(tag: string, props?: Record<string, unknown>, kids?: FakeNode[]): FakeNode {
  const node: FakeNode = {
    tag,
    props: props ?? {},
    children: [],
    listeners: {},
    textContent: '',
    dataset: {},
    src: '',
    value: '',
    files: [],
    hidden: false,
    append(...items) {
      node.children.push(...items);
    },
    addEventListener(name, fn) {
      node.listeners[name] = fn;
    },
    setAttribute(name, value) {
      node.props[name] = value;
    },
    click() {
      node.listeners.click?.();
    },
  };
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'text') node.textContent = String(value);
    else if (key === 'hidden') node.hidden = value === true;
    else if (key === 'value') node.value = String(value);
  }
  if (kids) node.children.push(...kids);
  return node;
}

/** 记录到的一条请求。 */
type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };

/** 造一个可驱动的上下文；fetch 记录请求，GET 回头像字节、POST 按给定应答返回。 */
function harness(options: { width?: number; height?: number; reply?: unknown } = {}) {
  const requests: Recorded[] = [];
  const reply = options.reply ?? { ok: true };
  let blobs = 0;
  const context: Record<string, unknown> = {
    API,
    TOKEN: 'test-token',
    state: { entry: 'shuai', petIndex: 0 },
    make,
    setStatus(node: FakeNode, text: string, kind?: string) {
      node.textContent = text;
      node.dataset.kind = kind ?? '';
    },
    encodeURIComponent,
    JSON,
    Math,
    String,
    Date,
    Promise,
    Error,
    URL: {
      createObjectURL: () => 'blob:avatar-' + (blobs += 1),
      revokeObjectURL() {},
    },
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: init?.body ?? '',
      });
      if (url.includes('/pet-avatar?')) return { ok: true, status: 200, json: async () => reply };
      return { ok: true, status: 200, blob: async () => ({ size: 1 }) };
    },
    createImageBitmap: async () => ({ width: options.width ?? 100, height: options.height ?? 100 }),
    FileReader: class {
      result = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(file: { base64: string }) {
        this.result = 'data:image/png;base64,' + file.base64;
        queueMicrotask(() => this.onload?.());
      }
    },
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/png;base64,SCALED',
      }),
    },
  };
  runInNewContext(avatarScript({ logoUrl: LOGO, maxSide: AVATAR_MAX_SIDE_PX }), context);
  return { context, requests };
}

/** 等两轮事件循环：预览取图与上传都是异步的。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** 从行里取出隐藏的 file input（它在 .avatarBox 里，不在行根上）。 */
function fileInput(row: FakeNode): FakeNode {
  const box = row.children.find((child) => child.props.class === 'avatarBox');
  const input = box?.children.find((child) => child.props.type === 'file');
  assert.ok(input, '可换头像的条目必须带隐藏的 file input');
  return input;
}

/** 触发一次选图并等上传落定。 */
async function pick(input: FakeNode, file: unknown): Promise<void> {
  input.files = [file];
  input.listeners.change?.();
  await settle();
}

test('内置条目：照样显示预览，但没有上传按钮', async () => {
  const { context, requests } = harness();
  (context.state as { entry: string }).entry = 'main';
  const row = (context.avatarRow as (pet: Record<string, never>) => FakeNode)({});
  await settle();
  assert.match(requests[0].url, /^\/dsh-pet-7340\/logo\?v=\d+$/, '内置条目取包内 logo，不带 root');
  assert.equal(requests[0].headers['X-DSH-Pet-Token'], 'test-token', '取图必须带令牌，否则打包版 403');
  assert.match(row.children[0].src, /^blob:avatar-/, '预览走 blob，不把地址直接塞进 img src');
  const box = row.children.find((child) => child.props.class === 'avatarBox');
  assert.ok(box);
  assert.equal(
    box.children.some((child) => child.props.type === 'file'),
    false,
    '内置条目不得出现文件选择框',
  );
  assert.equal(
    box.children.some((child) => child.textContent === '上传头像'),
    false,
    '内置条目不得出现上传按钮',
  );
});

test('素材根条目：条目名就是素材根，取图地址带 root 与版本号', async () => {
  const { context, requests } = harness();
  (context.avatarRow as (pet: Record<string, never>) => FakeNode)({});
  await settle();
  assert.match(requests[0].url, /^\/dsh-pet-7340\/logo\?root=shuai&v=\d+$/, '/config 里没有 assetRoot 时按条目名取');
});

test('长边在上限内：原样上传原图字节，请求带令牌，成功后重取预览', async () => {
  const { context, requests } = harness({ width: 400, height: 300 });
  const row = (context.avatarRow as (pet: Record<string, never>) => FakeNode)({});
  await settle();
  const before = requests[0].url;
  await pick(fileInput(row), { base64: 'ORIGINAL' });
  const upload = requests.find((request) => request.url.includes('/pet-avatar?'));
  assert.ok(upload, '必须发出上传请求');
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, API + '/pet-avatar?root=shuai', '上传参数是 root（素材根），不是 pet');
  assert.equal(upload.headers['X-DSH-Pet-Token'], 'test-token');
  assert.deepEqual(JSON.parse(upload.body), { base64: 'ORIGINAL' });
  const refetch = requests.filter((request) => request.url.startsWith(LOGO)).pop();
  assert.ok(refetch, '上传成功后必须重新取图');
  assert.notEqual(refetch.url, before, '重取时必须换版本号');
});

test('超过长边上限：先缩边再上传 PNG', async () => {
  const { context, requests } = harness({ width: 1200, height: 800 });
  const row = (context.avatarRow as (pet: Record<string, never>) => FakeNode)({});
  await settle();
  await pick(fileInput(row), { base64: 'ORIGINAL' });
  const upload = requests.find((request) => request.url.includes('/pet-avatar?'));
  assert.ok(upload);
  assert.deepEqual(JSON.parse(upload.body), { base64: 'SCALED' });
});

test('服务端拒绝：把它的文案原样显示出来', async () => {
  const { context } = harness({ reply: { ok: false, message: '只支持 PNG / JPEG / WebP / GIF' } });
  const row = (context.avatarRow as (pet: Record<string, never>) => FakeNode)({});
  await settle();
  const box = row.children.find((child) => child.props.class === 'avatarBox');
  assert.ok(box);
  const status = box.children[box.children.length - 1];
  await pick(fileInput(row), { base64: 'ORIGINAL' });
  assert.equal(status.textContent, '只支持 PNG / JPEG / WebP / GIF');
  assert.equal(status.dataset.kind, 'error');
});

test('页面注入的长边上限与插件客户端保持一致', () => {
  assert.equal(AVATAR_MAX_SIDE_PX, CLIENT_AVATAR_MAX_SIDE_PX, '两处上限不一致会让页面缩得比后端允许多或少');
});
