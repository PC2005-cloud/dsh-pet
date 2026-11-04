// dsh-pet 桌面图标碰撞 —— 桌面图标桥（Windows 专用的小后台进程，无窗口；仅在 physics.iconCollision = true 时使用）
//
// 职责只有「读 / 挪桌面图标」，物理全在 Electron 主进程（main/icon-world.js）里算：
//   - 连接桌面列表视图（Shell 的 IFolderView2 + SysListView32）
//   - 上报图标位置、图标格子大小、各显示器工作区（全部是**物理像素的屏幕坐标**）
//   - 按主进程的指令移动图标（LVM_SETITEMPOSITION 按序号直发，不注入 Explorer）
//   - 启动时备份布局（被物理打乱、还没还原时沿用旧备份）；收到 R 指令还原
//   - 运行期间临时关闭「自动排列」「对齐到网格」，退出时恢复
//   - 你在桌面上按住鼠标（框选/拖图标）或在重命名时上报 busy，让物理暂停
//   - 前台在跑全屏程序（游戏、演示）时上报 fullscreen，物理暂停
//   - **stdin 关闭 = 主进程没了**（宿主硬杀 helper 时也成立）：立刻恢复设置并退出
//
// 协议：stdin 每行一条指令，stdout 每行一条 JSON
//   M i x y [i x y ...]   把序号 i 的图标左上角挪到屏幕坐标 (x, y)
//   S                     立刻上报一次 icons
//   R                     还原到启动时备份的布局
//   E 0|1                 退出时是否还原布局
//   Q                     恢复设置后退出
//
// 由 main/icon-collision.js 在首次启用时用 Windows 自带的 csc.exe 编译（C# 5 语法，无需安装任何东西）。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshPetIconBridge
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X, Y;
        public POINT(int x, int y) { X = x; Y = y; }
    }

    [ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    interface IShellWindows
    {
        int Count { get; }
        [return: MarshalAs(UnmanagedType.IDispatch)] object Item(object index);
        [return: MarshalAs(UnmanagedType.IUnknown)] object _NewEnum();
        void Register([MarshalAs(UnmanagedType.IDispatch)] object pid, int hwnd, int swClass, out int plCookie);
        void RegisterPending(int lThreadId, ref object pvarloc, ref object pvarlocRoot, int swClass, out int plCookie);
        void Revoke(int lCookie);
        void OnNavigate(int lCookie, ref object pvarLoc);
        void OnActivated(int lCookie, [MarshalAs(UnmanagedType.VariantBool)] bool fActive);
        [return: MarshalAs(UnmanagedType.IDispatch)]
        object FindWindowSW(ref object pvarLoc, ref object pvarLocRoot, int swClass, out int phwnd, int swfwOptions);
        void OnCreated(int lCookie, [MarshalAs(UnmanagedType.IUnknown)] object punk);
        void ProcessAttachDetach([MarshalAs(UnmanagedType.VariantBool)] bool fAttach);
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IServiceProviderNative
    {
        void QueryService(ref Guid guidService, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppvObject);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellBrowser
    {
        void GetWindow(out IntPtr phwnd);
        void ContextSensitiveHelp(int fEnterMode);
        void InsertMenusSB(IntPtr hmenuShared, IntPtr lpMenuWidths);
        void SetMenuSB(IntPtr hmenuShared, IntPtr holemenuRes, IntPtr hwndActiveObject);
        void RemoveMenusSB(IntPtr hmenuShared);
        void SetStatusTextSB(IntPtr pszStatusText);
        void EnableModelessSB(int fEnable);
        void TranslateAcceleratorSB(IntPtr pmsg, ushort wID);
        void BrowseObject(IntPtr pidl, uint wFlags);
        void GetViewStateStream(uint grfMode, out IntPtr ppStrm);
        void GetControlWindow(uint id, out IntPtr phwnd);
        void SendControlMsg(uint id, uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr pret);
        void QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object ppshv);
    }

    [ComImport, Guid("1af3a467-214f-4298-908e-06b03e0b39f9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFolderView2
    {
        void GetCurrentViewMode(out uint pViewMode);
        void SetCurrentViewMode(uint ViewMode);
        void GetFolder(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
        void Item(int iItemIndex, out IntPtr ppidl);
        void ItemCount(uint uFlags, out int pcItems);
        void Items(uint uFlags, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
        void GetSelectionMarkedItem(out int piItem);
        void GetFocusedItem(out int piItem);
        void GetItemPosition(IntPtr pidl, out POINT ppt);
        void GetSpacing(out POINT ppt);
        void GetDefaultSpacing(out POINT ppt);
        [PreserveSig] int GetAutoArrange();
        void SelectItem(int iItem, uint dwFlags);
        void SelectAndPositionItems(uint cidl,
            [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl,
            [In, MarshalAs(UnmanagedType.LPArray)] POINT[] apt,
            uint dwFlags);
        void SetGroupBy(IntPtr key, int fAscending);
        void GetGroupBy(IntPtr pkey, out int pfAscending);
        void SetViewProperty(IntPtr pidl, IntPtr propkey, IntPtr propvar);
        void GetViewProperty(IntPtr pidl, IntPtr propkey, IntPtr ppropvar);
        void SetTileViewProperties(IntPtr pidl, IntPtr pszPropList);
        void SetExtendedTileViewProperties(IntPtr pidl, IntPtr pszPropList);
        void SetText(int iType, IntPtr pwszText);
        void SetCurrentFolderFlags(uint dwMask, uint dwFlags);
        void GetCurrentFolderFlags(out uint pdwFlags);
    }

    static class Native
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("shell32.dll")] public static extern int SHGetNameFromIDList(IntPtr pidl, uint sigdn, out IntPtr name);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);

        public const uint GA_ROOT = 2;

        public static string ClassName(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        // 异步投递：一批移动全部排进 Explorer 的消息队列，它处理完整批才重绘一次（同步发送会每挪一个就等一次、重绘一次）
        public static bool PostItemPos(IntPtr lv, int index, int x, int y)
        {
            int packed = (y << 16) | (x & 0xFFFF);
            return PostMessage(lv, 0x1000 + 15 /*LVM_SETITEMPOSITION*/, new IntPtr(index), new IntPtr(packed));
        }

        public static bool SetItemPos(IntPtr lv, int index, int x, int y)
        {
            int packed = (y << 16) | (x & 0xFFFF);
            IntPtr res;
            return SendMessageTimeout(lv, 0x1000 + 15 /*LVM_SETITEMPOSITION*/, new IntPtr(index), new IntPtr(packed),
                                      0x0002 /*SMTO_ABORTIFHUNG*/, 50, out res) != IntPtr.Zero;
        }
    }

    class Item
    {
        public IntPtr Pidl;
        public int X, Y;        // 列表视图客户区坐标（左上角）
        public string Key;
    }

    static class Program
    {
        const uint SVGIO_ALLVIEW = 0x2;
        const uint SVSI_POSITIONITEM = 0x80;
        const uint FWF_AUTOARRANGE = 0x1;
        const uint FWF_SNAPTOGRID = 0x4;
        const uint FLAG_MASK = FWF_AUTOARRANGE | FWF_SNAPTOGRID;
        const uint SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000;

        static readonly object outLock = new object();
        static TextWriter stdout;   // winexe 没有控制台：不能碰 Console.OutputEncoding（会调 SetConsoleOutputCP 抛异常），自己包一层
        static readonly Queue<string> commands = new Queue<string>();
        static readonly AutoResetEvent wake = new AutoResetEvent(false);   // 有指令到达立刻唤醒主循环
        static readonly Dictionary<int, POINT> pendingMoves = new Dictionary<int, POINT>();   // 本轮合并后的目标位置
        static volatile bool stdinClosed;

        static IFolderView2 fv;
        static IntPtr listView = IntPtr.Zero;
        static int offX, offY;                 // 屏幕 → 客户区
        static readonly List<Item> items = new List<Item>();
        static bool useLvm;
        static string dataDir;
        static string backupPath, dirtyPath;
        static bool dirty;   // 物理挪过图标、还没还原：此时的布局不是你的，重启后不能拿它当备份
        static readonly Dictionary<string, POINT> snapshot = new Dictionary<string, POINT>();
        static uint origFlags;
        static bool flagsKnown;
        static bool restoreOnExit;
        static bool lastBusy, lastBlocked;
        static bool lastLDown, desktopPress;
        static readonly Dictionary<int, POINT> pendingSlow = new Dictionary<int, POINT>();

        static void Out(string json)
        {
            lock (outLock)
            {
                try { stdout.Write(json + "\n"); stdout.Flush(); } catch { }
            }
        }

        static string Esc(string s)
        {
            return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }

        [STAThread]
        static int Main(string[] args)
        {
            try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
            catch { try { Native.SetProcessDPIAware(); } catch { } }

            try { Native.timeBeginPeriod(1); } catch { }
            dataDir = args.Length > 0 ? args[0] : AppDomain.CurrentDomain.BaseDirectory;
            try { Directory.CreateDirectory(dataDir); } catch { }
            backupPath = Path.Combine(dataDir, "layout_backup.txt");
            dirtyPath = Path.Combine(dataDir, "dirty.flag");

            StreamWriter w = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            w.AutoFlush = false;
            stdout = w;
            Thread reader = new Thread(ReadStdin);
            reader.IsBackground = true;
            reader.Start();

            bool connected = false;
            Stopwatch clock = Stopwatch.StartNew();
            long nextInit = 0, lastCount = 0, lastFlags = 0, lastBusyCheck = 0, lastSlowFlush = 0, lastFsCheck = 0;
            bool lastFullscreen = false;
            long syncAt = -1;

            while (true)
            {
                long now = clock.ElapsedMilliseconds;
                try
                {
                    if (!connected)
                    {
                        if (now >= nextInit)
                        {
                            nextInit = now + 3000;
                            connected = Connect();
                            if (connected) { AfterConnect(); Snapshot(); }
                        }
                    }

                    // 指令
                    while (true)
                    {
                        string cmd;
                        lock (commands) { if (commands.Count == 0) break; cmd = commands.Dequeue(); }
                        if (cmd == "Q") { ApplyMoves(); Cleanup(); return 0; }
                        if (connected) Handle(cmd);
                        else if (cmd.StartsWith("E ")) restoreOnExit = cmd.Substring(2).Trim() == "1";
                    }
                    // 积压的多条 M 已合并成每个图标的最新位置：一次性投递，不会越积越多
                    if (connected) ApplyMoves();
                    if (stdinClosed) { Cleanup(); return 0; }

                    if (connected)
                    {
                        if (!useLvm && pendingSlow.Count > 0 && now - lastSlowFlush > 50)
                        {
                            lastSlowFlush = now;
                            FlushSlow();
                        }
                        if (now - lastBusyCheck >= 30)
                        {
                            lastBusyCheck = now;
                            bool busy = UserBusy();
                            if (busy != lastBusy)
                            {
                                lastBusy = busy;
                                Out("{\"t\":\"busy\",\"v\":" + (busy ? "true" : "false") + "}");
                                if (!busy) syncAt = now + 300;   // 你刚动过图标：稍后把真实位置同步给主进程
                            }
                        }
                        if (now - lastCount >= 1000)
                        {
                            lastCount = now;
                            int n;
                            fv.ItemCount(SVGIO_ALLVIEW, out n);
                            if (n != items.Count) syncAt = now;
                        }
                        if (now - lastFsCheck >= 1000)
                        {
                            lastFsCheck = now;
                            bool fs = Fullscreen();
                            if (fs != lastFullscreen)
                            {
                                lastFullscreen = fs;
                                Out("{\"t\":\"fullscreen\",\"v\":" + (fs ? "true" : "false") + "}");
                            }
                        }
                        if (now - lastFlags >= 3000)
                        {
                            lastFlags = now;
                            CheckFlags();
                        }
                        if (syncAt >= 0 && now >= syncAt && !lastBusy)
                        {
                            syncAt = -1;
                            Snapshot();
                        }
                    }
                }
                catch (Exception ex)
                {
                    Out("{\"t\":\"err\",\"m\":\"" + Esc(ex.Message) + "\"}");
                    connected = false;
                    Release();
                    nextInit = now + 2000;
                }
                wake.WaitOne(10);
            }
        }

        // QUNS_BUSY(2) = 全屏程序；QUNS_RUNNING_D3D_FULL_SCREEN(3) = D3D 独占全屏；QUNS_PRESENTATION_MODE(4) = 演示模式
        static bool Fullscreen()
        {
            try { int st; if (Native.SHQueryUserNotificationState(out st) == 0) return st == 2 || st == 3 || st == 4; }
            catch { }
            return false;
        }

        static void ReadStdin()
        {
            try
            {
                TextReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = r.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (line.Length == 0) continue;
                    lock (commands) commands.Enqueue(line);
                    wake.Set();
                }
            }
            catch { }
            stdinClosed = true;
            wake.Set();
        }

        static void Handle(string cmd)
        {
            char c = cmd[0];
            if (c == 'M')
            {
                string[] p = cmd.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                for (int k = 1; k + 2 < p.Length; k += 3)
                {
                    int i, x, y;
                    if (!int.TryParse(p[k], out i) || !int.TryParse(p[k + 1], out x) || !int.TryParse(p[k + 2], out y)) continue;
                    if (i < 0 || i >= items.Count) continue;
                    pendingMoves[i] = new POINT(x - offX, y - offY);
                }
                return;
            }
            ApplyMoves();   // 其它指令之前先把已收到的移动落地，保证顺序
            if (c == 'S') Snapshot();
            else if (c == 'R') { Thread.Sleep(60); Restore(); Snapshot(); }
            else if (c == 'E') restoreOnExit = cmd.Length > 2 && cmd.Substring(2).Trim() == "1";
        }

        static void ApplyMoves()
        {
            if (pendingMoves.Count == 0) return;
            int lastMoved = -1;
            foreach (KeyValuePair<int, POINT> kv in pendingMoves)
            {
                if (kv.Key >= items.Count) continue;
                if (MoveTo(kv.Key, kv.Value.X, kv.Value.Y)) lastMoved = kv.Key;
            }
            pendingMoves.Clear();
            // 节流闸门：等桌面把这一批真正处理完再收下一批。
            // 跨进程的 COM 调用和刚才投递的移动消息排在 Explorer 同一个消息队列里，按顺序处理——
            // 它返回就说明前面的移动都做完了。等待期间新来的指令在 pendingMoves 里只保留每个图标的最新位置，
            // 桌面跟不上时自动跳过中间帧，延迟不会越积越多。
            if (useLvm && lastMoved >= 0 && items[lastMoved].Pidl != IntPtr.Zero)
            {
                try { POINT p; fv.GetItemPosition(items[lastMoved].Pidl, out p); } catch { }
            }
        }

        static bool MoveTo(int i, int cx, int cy)
        {
            Item it = items[i];
            if (it.X == cx && it.Y == cy) return false;
            if (!dirty)
            {
                dirty = true;
                try { File.WriteAllText(dirtyPath, DateTime.Now.ToString("s")); } catch { }
            }
            if (useLvm)
            {
                if (Native.PostItemPos(listView, i, cx, cy) || Native.SetItemPos(listView, i, cx, cy)) { it.X = cx; it.Y = cy; return true; }
                return false;
            }
            pendingSlow[i] = new POINT(cx, cy);
            return true;
        }

        static void FlushSlow()
        {
            List<IntPtr> ids = new List<IntPtr>();
            List<POINT> pts = new List<POINT>();
            foreach (KeyValuePair<int, POINT> kv in pendingSlow)
            {
                Item it = items[kv.Key];
                ids.Add(it.Pidl);
                pts.Add(kv.Value);
                it.X = kv.Value.X; it.Y = kv.Value.Y;
            }
            pendingSlow.Clear();
            if (ids.Count > 0) fv.SelectAndPositionItems((uint)ids.Count, ids.ToArray(), pts.ToArray(), SVSI_POSITIONITEM);
        }

        // ───── 连接桌面 ─────

        static bool Connect()
        {
            try
            {
                object shwObj = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("9BA05972-F6A8-11CF-A442-00A0C90A8F39")));
                IShellWindows shw = (IShellWindows)shwObj;
                object loc = 0;
                object root = null;
                int hwnd;
                object disp = shw.FindWindowSW(ref loc, ref root, 8 /*SWC_DESKTOP*/, out hwnd, 1 /*SWFO_NEEDDISPATCH*/);
                IServiceProviderNative sp = (IServiceProviderNative)disp;
                Guid sid = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
                Guid iid = typeof(IShellBrowser).GUID;
                object browserObj;
                sp.QueryService(ref sid, ref iid, out browserObj);
                object viewObj;
                ((IShellBrowser)browserObj).QueryActiveShellView(out viewObj);
                fv = (IFolderView2)viewObj;
                listView = FindDesktopListView();
                return true;
            }
            catch (Exception ex)
            {
                Out("{\"t\":\"err\",\"m\":\"connect: " + Esc(ex.Message) + "\"}");
                Release();
                return false;
            }
        }

        static void Release()
        {
            foreach (Item it in items) if (it.Pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(it.Pidl);
            items.Clear();
            if (fv != null) { try { Marshal.ReleaseComObject(fv); } catch { } }
            fv = null;
            listView = IntPtr.Zero;
            useLvm = false;
        }

        static IntPtr FindDesktopListView()
        {
            IntPtr lv = ListViewUnder(Native.FindWindow("Progman", null));
            if (lv != IntPtr.Zero) return lv;
            IntPtr found = IntPtr.Zero;
            Native.EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (Native.ClassName(h) != "WorkerW") return true;
                IntPtr r = ListViewUnder(h);
                if (r != IntPtr.Zero) { found = r; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        static IntPtr ListViewUnder(IntPtr top)
        {
            if (top == IntPtr.Zero) return IntPtr.Zero;
            IntPtr defView = Native.FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView == IntPtr.Zero) return IntPtr.Zero;
            return Native.FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
        }

        static void AfterConnect()
        {
            uint flags = 0;
            try { fv.GetCurrentFolderFlags(out flags); } catch { }
            if (!flagsKnown)
            {
                flagsKnown = true;
                dirty = File.Exists(dirtyPath);
                if (dirty && LoadBackup())
                {
                    // 上次被物理打乱后没有还原：沿用那时备份的原始布局（不能拿现在乱掉的布局当备份）
                }
                else
                {
                    origFlags = flags & FLAG_MASK;
                    ReadItems();
                    snapshot.Clear();
                    foreach (Item it in items)
                    {
                        string k = KeyOf(it);
                        if (!snapshot.ContainsKey(k)) snapshot[k] = new POINT(it.X, it.Y);
                    }
                    SaveBackup();
                    dirty = false;
                }
            }
            if ((flags & FLAG_MASK) != 0)
            {
                try { fv.SetCurrentFolderFlags(FLAG_MASK, 0); } catch { }
            }
            CheckFlags();
        }

        static void CheckFlags()
        {
            uint f;
            try { fv.GetCurrentFolderFlags(out f); } catch { return; }
            bool blocked = (f & FWF_AUTOARRANGE) != 0;
            if (blocked != lastBlocked)
            {
                lastBlocked = blocked;
                Out("{\"t\":\"blocked\",\"v\":" + (blocked ? "true" : "false") + "}");
                if (!blocked) Snapshot();
            }
        }

        static void ReadItems()
        {
            foreach (Item it in items) if (it.Pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(it.Pidl);
            items.Clear();
            int n;
            fv.ItemCount(SVGIO_ALLVIEW, out n);
            for (int i = 0; i < n; i++)
            {
                IntPtr pidl;
                try { fv.Item(i, out pidl); } catch { pidl = IntPtr.Zero; }
                Item it = new Item();
                it.Pidl = pidl;
                if (pidl != IntPtr.Zero)
                {
                    POINT p;
                    try { fv.GetItemPosition(pidl, out p); it.X = p.X; it.Y = p.Y; } catch { }
                }
                items.Add(it);   // 序号必须和列表视图一一对应，取不到的也占位
            }
            POINT o = new POINT(0, 0);
            if (listView != IntPtr.Zero) Native.ScreenToClient(listView, ref o);
            offX = -o.X;   // 客户区 (0,0) 对应的屏幕坐标
            offY = -o.Y;
            if (!lastBlocked) VerifyLvm();
        }

        // 挪第一个和最后一个图标 1 像素再读回来，确认列表视图的序号和 IFolderView 的序号对得上
        static void VerifyLvm()
        {
            useLvm = false;
            if (listView == IntPtr.Zero || items.Count == 0) return;
            int[] probes = items.Count > 1 ? new int[] { 0, items.Count - 1 } : new int[] { 0 };
            foreach (int i in probes)
            {
                Item it = items[i];
                if (it.Pidl == IntPtr.Zero) return;
                Native.SetItemPos(listView, i, it.X + 1, it.Y);
                POINT p;
                fv.GetItemPosition(it.Pidl, out p);
                bool ok = p.X == it.X + 1 && p.Y == it.Y;
                fv.SelectAndPositionItems(1, new IntPtr[] { it.Pidl }, new POINT[] { new POINT(it.X, it.Y) }, SVSI_POSITIONITEM);
                if (!ok) return;
            }
            useLvm = true;
        }

        static void Snapshot()
        {
            ReadItems();
            POINT sp = new POINT(0, 0);
            try { fv.GetSpacing(out sp); } catch { }
            if ((sp.X <= 0 || sp.Y <= 0) && listView != IntPtr.Zero)
            {
                long r = Native.SendMessage(listView, 0x1000 + 51 /*LVM_GETITEMSPACING*/, IntPtr.Zero, IntPtr.Zero).ToInt64();
                sp.X = (int)(r & 0xFFFF);
                sp.Y = (int)((r >> 16) & 0xFFFF);
            }
            if (sp.X <= 0 || sp.Y <= 0) sp = new POINT(76, 96);

            StringBuilder sb = new StringBuilder(64 + items.Count * 16);
            sb.Append("{\"t\":\"icons\",\"lvm\":").Append(useLvm ? "true" : "false");
            sb.Append(",\"cw\":").Append(sp.X).Append(",\"ch\":").Append(sp.Y);
            sb.Append(",\"items\":[");
            for (int i = 0; i < items.Count; i++)
            {
                Item it = items[i];
                if (i > 0) sb.Append(',');
                if (it.Pidl == IntPtr.Zero) sb.Append("null");
                else sb.Append('[').Append(it.X + offX).Append(',').Append(it.Y + offY).Append(']');
            }
            sb.Append("],\"areas\":[");
            Screen[] all = Screen.AllScreens;
            for (int i = 0; i < all.Length; i++)
            {
                System.Drawing.Rectangle w = all[i].WorkingArea;
                if (i > 0) sb.Append(',');
                sb.Append('[').Append(w.Left).Append(',').Append(w.Top).Append(',').Append(w.Right).Append(',').Append(w.Bottom).Append(']');
            }
            sb.Append("]}");
            Out(sb.ToString());
        }

        // 只有在桌面空白处/图标上按下鼠标（框选、拖图标）或正在重命名时才算「你在用桌面」
        static bool UserBusy()
        {
            if (listView == IntPtr.Zero) return false;
            IntPtr edit = Native.FindWindowEx(listView, IntPtr.Zero, "Edit", null);
            if (edit != IntPtr.Zero && Native.IsWindowVisible(edit)) return true;
            bool down = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
            if (down && !lastLDown)
            {
                POINT p;
                Native.GetCursorPos(out p);
                IntPtr w = Native.WindowFromPoint(p);
                desktopPress = w != IntPtr.Zero &&
                    (w == listView || Native.GetAncestor(w, Native.GA_ROOT) == Native.GetAncestor(listView, Native.GA_ROOT));
            }
            if (!down) desktopPress = false;
            lastLDown = down;
            return desktopPress;
        }

        // ───── 布局备份 ─────

        static string KeyOf(Item it)
        {
            if (it.Key != null) return it.Key;
            if (it.Pidl == IntPtr.Zero) return it.Key = "";
            IntPtr name;
            if (Native.SHGetNameFromIDList(it.Pidl, SIGDN_DESKTOPABSOLUTEPARSING, out name) == 0 && name != IntPtr.Zero)
            {
                string s = Marshal.PtrToStringUni(name);
                Marshal.FreeCoTaskMem(name);
                if (!string.IsNullOrEmpty(s)) return it.Key = s;
            }
            int size = 0;
            while (size < 65536)
            {
                int cb = (ushort)Marshal.ReadInt16(it.Pidl, size);
                if (cb == 0) break;
                size += cb;
            }
            byte[] buf = new byte[size];
            Marshal.Copy(it.Pidl, buf, 0, size);
            return it.Key = "#" + Convert.ToBase64String(buf);
        }

        static void SaveBackup()
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("#flags=" + origFlags.ToString(CultureInfo.InvariantCulture));
                foreach (KeyValuePair<string, POINT> kv in snapshot)
                    sb.AppendLine(kv.Key + "\t" + kv.Value.X + "\t" + kv.Value.Y);
                File.WriteAllText(backupPath, sb.ToString(), new UTF8Encoding(true));
            }
            catch { }
        }

        static bool LoadBackup()
        {
            try
            {
                snapshot.Clear();
                foreach (string line in File.ReadAllLines(backupPath, Encoding.UTF8))
                {
                    if (line.StartsWith("#flags="))
                    {
                        uint f;
                        if (uint.TryParse(line.Substring(7), out f)) origFlags = f & FLAG_MASK;
                        continue;
                    }
                    string[] parts = line.Split('\t');
                    if (parts.Length != 3) continue;
                    int x, y;
                    if (int.TryParse(parts[1], out x) && int.TryParse(parts[2], out y)) snapshot[parts[0]] = new POINT(x, y);
                }
                return snapshot.Count > 0;
            }
            catch { return false; }
        }

        static void Restore()
        {
            if (fv == null || snapshot.Count == 0) return;
            pendingSlow.Clear();
            ReadItems();
            List<IntPtr> ids = new List<IntPtr>();
            List<POINT> pts = new List<POINT>();
            foreach (Item it in items)
            {
                if (it.Pidl == IntPtr.Zero) continue;
                POINT p;
                if (snapshot.TryGetValue(KeyOf(it), out p)) { ids.Add(it.Pidl); pts.Add(p); }
            }
            if (ids.Count > 0) fv.SelectAndPositionItems((uint)ids.Count, ids.ToArray(), pts.ToArray(), SVSI_POSITIONITEM);
            dirty = false;
            try { File.Delete(dirtyPath); } catch { }
            Out("{\"t\":\"restored\",\"n\":" + ids.Count + "}");
        }

        static void Cleanup()
        {
            try { Native.timeEndPeriod(1); } catch { }
            try
            {
                if (fv != null)
                {
                    if (!useLvm && pendingSlow.Count > 0) FlushSlow();
                    if (restoreOnExit) Restore();
                    if (flagsKnown) fv.SetCurrentFolderFlags(FLAG_MASK, origFlags);
                }
            }
            catch { }
            Release();
        }
    }
}
