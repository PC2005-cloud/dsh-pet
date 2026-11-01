/**
 * 借 Windows 句柄表读被独占打开的 cookie 库（Chromium 的 `Network/Cookies`）。
 *
 * DSH 运行期间桌面外壳对该文件是独占打开，常规 `open()` 只会拿到 ERROR_SHARING_VIOLATION，
 * 复制、备份与 SQLite backup API 全部失败；这里枚举全机句柄表，对目标进程
 * `DuplicateHandle` 复制一个，再在副本上读字节。Node 没有 FFI，所以借 DSH 自带的那份
 * koffi 调 kernel32 与 ntdll——不装新依赖、不编译。读不到就把原因原样交回调用方，绝不猜数。
 * 移植自 dsh-cookie-guard 的 probe.js（MIT），逻辑未改，只做了类型化与拆分。
 * @module dsh-pet/src/host/cookie/win32
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 原生函数：签名由 koffi 按字符串校验，参数形状不在这里重复声明。 */
type NativeCall = (...args: unknown[]) => unknown;

/** 本模块用到的 kernel32 / ntdll 入口。 */
interface Win32Api {
  readonly CreateToolhelp32Snapshot: NativeCall;
  readonly Process32FirstW: NativeCall;
  readonly Process32NextW: NativeCall;
  readonly OpenProcess: NativeCall;
  readonly CloseHandle: NativeCall;
  readonly DuplicateHandle: NativeCall;
  readonly GetFinalPathNameByHandleW: NativeCall;
  readonly SetFilePointer: NativeCall;
  readonly ReadFile: NativeCall;
  readonly GetCurrentProcess: NativeCall;
  readonly NtQuerySystemInformation: NativeCall;
}

/** koffi 的最小面：load 一个库，再按 C 签名取函数。 */
interface KoffiModule {
  load(library: string): { func(signature: string): NativeCall };
}

/** 借壳读取的结论；失败只给原因，不伪造条数。 */
export type JarRead =
  | { readonly ok: true; readonly raw: Buffer; readonly source: 'file' | 'borrowed-handle' }
  | { readonly ok: false; readonly reason: string };

/** FFI 装载结论；成功后缓存，失败也缓存（重试只会重复扫同样的路径）。 */
type Ffi = { readonly ok: true; readonly api: Win32Api } | { readonly ok: false; readonly reason: string };

/** TH32CS_SNAPPROCESS */
const SNAPSHOT_PROCESSES = 0x2;
/** PROCESSENTRY32W 的大小。 */
const PROCESS_ENTRY_BYTES = 568;
/** SystemExtendedHandleInformation 的条目步长。 */
const HANDLE_ENTRY_STRIDE = 40;
/** SystemExtendedHandleInformation 的信息类。 */
const HANDLE_INFORMATION_CLASS = 64;
/** PROCESS_DUP_HANDLE */
const PROCESS_DUP_HANDLE = 0x40;
/** DUPLICATE_SAME_ACCESS */
const DUPLICATE_SAME_ACCESS = 0x2;
/** STATUS_BUFFER_TOO_SMALL */
const STATUS_BUFFER_TOO_SMALL = 0xc0000004;
/** 句柄表初始缓冲：这台机器上约 137 万个句柄，一次给够能少调用一轮。 */
const HANDLE_TABLE_INITIAL_BYTES = 32 << 20;
/** 缓冲不够时的余量：句柄每拍都在变，留够增量比精确计算稳妥。 */
const HANDLE_TABLE_SLACK_BYTES = 4 << 20;
/** 单次读取块。 */
const READ_CHUNK_BYTES = 1 << 20;
/** GetFinalPathNameByHandleW 的宽字符缓冲长度。 */
const PATH_CHARS = 4096;
/** 目标库在句柄路径里的后缀（小写比对）。 */
const TARGET_SUFFIX = '\\network\\cookies';
/** 认准 cookie 库的同时排除平台登录用的分区副本来。 */
const PARTITION_MARK = 'partitions';

let ffiCache: Ffi | undefined;

/** 句柄类返回值：koffi 可能给 number、BigInt 或 null，三种都算空。 */
function isNullHandle(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}

/** DSH 自带的 koffi 在不同安装方式下位置不同，按可能性依次找。 */
function koffiCandidates(): string[] {
  const out: string[] = [];
  const override = process.env.DSH_PET_COOKIE_KOFFI;
  if (typeof override === 'string' && override.trim() !== '') out.push(override);

  const resourcesPath = (process as { resourcesPath?: unknown }).resourcesPath;
  const roots: string[] = [];
  if (typeof resourcesPath === 'string') roots.push(resourcesPath);
  const execPath = process.execPath ?? '';
  if (execPath !== '') {
    roots.push(join(execPath, '..', 'resources'));
    roots.push(join(execPath, '..'));
  }
  for (const root of roots) {
    out.push(join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs'));
    out.push(join(root, 'dsh', 'node_modules', 'koffi', 'index.cjs'));
    out.push(join(root, 'node_modules', 'koffi', 'index.cjs'));
  }
  return out;
}

/** 找不到 koffi 时说明「为什么不行」，不改用别的途径猜数。 */
function loadFfi(): Ffi {
  if (ffiCache !== undefined) return ffiCache;
  if (process.platform !== 'win32') {
    ffiCache = { ok: false, reason: '仅支持 Windows' };
    return ffiCache;
  }
  for (const candidate of koffiCandidates()) {
    try {
      statSync(candidate);
    } catch {
      continue;
    }
    try {
      const require = createRequire(import.meta.url);
      const koffi = require(candidate) as KoffiModule;
      const kernel32 = koffi.load('kernel32.dll');
      const ntdll = koffi.load('ntdll.dll');
      ffiCache = {
        ok: true,
        api: {
          CreateToolhelp32Snapshot: kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32, uint32)'),
          Process32FirstW: kernel32.func('int32 __stdcall Process32FirstW(void *, void *)'),
          Process32NextW: kernel32.func('int32 __stdcall Process32NextW(void *, void *)'),
          OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32, int32, uint32)'),
          CloseHandle: kernel32.func('int32 __stdcall CloseHandle(void *)'),
          DuplicateHandle: kernel32.func(
            'int32 __stdcall DuplicateHandle(void *, void *, void *, void **, uint32, int32, uint32)',
          ),
          GetFinalPathNameByHandleW: kernel32.func(
            'uint32 __stdcall GetFinalPathNameByHandleW(void *, void *, uint32, uint32)',
          ),
          SetFilePointer: kernel32.func('uint32 __stdcall SetFilePointer(void *, int32, void *, uint32)'),
          ReadFile: kernel32.func('int32 __stdcall ReadFile(void *, void *, uint32, uint32 *, void *)'),
          GetCurrentProcess: kernel32.func('void * __stdcall GetCurrentProcess()'),
          NtQuerySystemInformation: ntdll.func(
            'long __stdcall NtQuerySystemInformation(uint32, void *, uint32, uint32 *)',
          ),
        },
      };
      return ffiCache;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ffiCache = { ok: false, reason: `koffi 加载失败：${message}` };
      return ffiCache;
    }
  }
  ffiCache = { ok: false, reason: '没找到 DSH 自带的 koffi' };
  return ffiCache;
}

/** 找出可能打开着 cookie 库的进程：外壳本体与 DSH 桌面进程都算。 */
function cookieProcesses(api: Win32Api): number[] {
  const snapshot = api.CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0);
  if (isNullHandle(snapshot)) return [];

  const entry = Buffer.alloc(PROCESS_ENTRY_BYTES);
  entry.writeUInt32LE(PROCESS_ENTRY_BYTES, 0);
  const found: number[] = [];
  let more = Boolean(api.Process32FirstW(snapshot, entry));
  while (more) {
    const pid = entry.readUInt32LE(8);
    const exe = entry
      .toString('utf16le', 44, 44 + 520)
      .split('\u0000')[0]
      ?.toLowerCase();
    if (pid !== process.pid && (exe?.includes('deepseek') === true || exe?.includes('dsh-desktop') === true)) {
      found.push(pid);
    }
    more = Boolean(api.Process32NextW(snapshot, entry));
  }
  api.CloseHandle(snapshot);
  return found;
}

/**
 * 枚举全机句柄表，把目标进程里指向 cookie 库的那一个复制出来再整个读一遍。
 *
 * @param api - 已装载的原生入口。
 * @param pids - 候选进程；命中第一个可读的句柄就返回。
 * @returns 文件字节；一个都没借到时返回 null。
 * @throws {Error} 句柄表查询失败（含状态码）时。
 */
function readThroughOpenHandle(api: Win32Api, pids: readonly number[]): Buffer | null {
  let size = HANDLE_TABLE_INITIAL_BYTES;
  let table = Buffer.alloc(size);
  const needed = Buffer.alloc(4);
  let status = Number(api.NtQuerySystemInformation(HANDLE_INFORMATION_CLASS, table, size, needed)) >>> 0;
  if (status === STATUS_BUFFER_TOO_SMALL) {
    size = needed.readUInt32LE(0) + HANDLE_TABLE_SLACK_BYTES;
    table = Buffer.alloc(size);
    status = Number(api.NtQuerySystemInformation(HANDLE_INFORMATION_CLASS, table, size, needed)) >>> 0;
  }
  if (status !== 0) throw new Error(`NtQuerySystemInformation 0x${status.toString(16)}`);

  const total = table.readUInt32LE(0);
  const wanted = new Set(pids);
  const self = api.GetCurrentProcess();
  const pathBuffer = Buffer.alloc(PATH_CHARS * 2);
  const handleOut = Buffer.alloc(8);
  const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
  const readOut = Buffer.alloc(4);

  for (let index = 0; index < total; index += 1) {
    const base = 16 + index * HANDLE_ENTRY_STRIDE;
    const pid = Number(table.readBigUInt64LE(base + 8));
    if (!wanted.has(pid)) continue;

    const handle = table.readBigUInt64LE(base + 16);
    const processHandle = api.OpenProcess(PROCESS_DUP_HANDLE, 0, pid);
    if (isNullHandle(processHandle)) continue;

    let copied: number;
    try {
      copied = Number(api.DuplicateHandle(processHandle, handle, self, handleOut, 0, 0, DUPLICATE_SAME_ACCESS));
    } catch {
      copied = 0;
    }
    api.CloseHandle(processHandle);
    if (copied === 0) continue;

    const duplicate = handleOut.readBigUInt64LE(0);
    const length = Number(api.GetFinalPathNameByHandleW(duplicate, pathBuffer, PATH_CHARS, 0));
    const path = length > 0 ? pathBuffer.toString('utf16le', 0, length * 2).toLowerCase() : '';
    if (!path.endsWith(TARGET_SUFFIX) || path.includes(PARTITION_MARK)) {
      api.CloseHandle(duplicate);
      continue;
    }

    api.SetFilePointer(duplicate, 0, null, 0);
    const chunks: Buffer[] = [];
    for (;;) {
      const okRead = Boolean(api.ReadFile(duplicate, readBuffer, readBuffer.length, readOut, null));
      const count = readOut.readUInt32LE(0);
      if (!okRead || count === 0) break;
      chunks.push(Buffer.from(readBuffer.subarray(0, count)));
      if (count < readBuffer.length) break;
    }
    api.CloseHandle(duplicate);
    return Buffer.concat(chunks);
  }
  return null;
}

/** DSH 没在运行时直接读文件——更快，也不需要借句柄。 */
function readDirectly(file: string): Buffer | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const size = statSync(file).size;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const got = readSync(fd, buffer, offset, size - offset, offset);
        if (got <= 0) break;
        offset += got;
      }
      return buffer.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 取 cookie 库的原始字节：先试直接读，再试借外壳已打开的句柄。
 *
 * @param file - cookie 库的绝对路径。
 * @returns 字节与来源，或不可读的原因。
 */
export function readJarBytes(file: string): JarRead {
  const direct = readDirectly(file);
  if (direct !== null && direct.length > 0) return { ok: true, raw: direct, source: 'file' };

  const ffi = loadFfi();
  if (!ffi.ok) return { ok: false, reason: ffi.reason };

  const pids = cookieProcesses(ffi.api);
  if (pids.length === 0) return { ok: false, reason: 'DSH 正在运行，但没有找到可借句柄的进程' };

  let raw: Buffer | null;
  try {
    raw = readThroughOpenHandle(ffi.api, pids);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `借句柄失败：${message}` };
  }
  if (raw === null || raw.length === 0) return { ok: false, reason: '没能从运行中的 DSH 借到 cookie 库句柄' };
  return { ok: true, raw, source: 'borrowed-handle' };
}
