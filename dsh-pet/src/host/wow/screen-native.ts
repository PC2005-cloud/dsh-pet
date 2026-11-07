/** Fixed PowerShell queries read only an identified game window; no desktop coordinates or user text enter script source. */

export const discoveryScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WarcraftWindowState {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  public static bool Visible(IntPtr handle) {
    int cloaked;
    return IsWindowVisible(handle) && (DwmGetWindowAttribute(handle, 14, out cloaked, 4) != 0 || cloaked == 0);
  }
  public static uint Owner(IntPtr handle) { uint processId; GetWindowThreadProcessId(handle, out processId); return processId; }
}
'@
$entries = @()
foreach ($gameProcess in @(Get-Process -Name 'Wow','WowClassic','Wow-arm64','WowClassic-arm64' -ErrorAction SilentlyContinue)) {
  try {
    $handle = $gameProcess.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero -or [WarcraftWindowState]::Owner($handle) -ne $gameProcess.Id) { continue }
    $program = $gameProcess.Path
    if ([string]::IsNullOrEmpty($program)) { continue }
    $entries += @{
      handle = $handle.ToInt64().ToString()
      processId = [int]$gameProcess.Id
      processStartedAt = $gameProcess.StartTime.ToUniversalTime().Ticks.ToString()
      path = $program
      title = $gameProcess.MainWindowTitle
      minimized = [WarcraftWindowState]::IsIconic($handle)
      visible = [WarcraftWindowState]::Visible($handle)
    }
  } catch { }
}
ConvertTo-Json -InputObject @($entries) -Compress
`;

/** HWND and process identity arrive as environment values, never interpolated PowerShell or C# code. PrintWindow cannot capture another desktop region. */
export const captureScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class WarcraftWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  public static void Check(IntPtr handle, uint expectedProcess) {
    uint owner; GetWindowThreadProcessId(handle, out owner);
    if (owner != expectedProcess) throw new Exception("window-changed");
    int cloaked;
    if (IsIconic(handle) || !IsWindowVisible(handle) || (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0)) throw new Exception("minimized-window");
  }
  public static byte[] Capture(IntPtr handle, uint owner, out int width, out int height) {
    Check(handle, owner);
    Rect rect;
    if (!GetWindowRect(handle, out rect)) throw new Exception("window-changed");
    int w = rect.Right - rect.Left, h = rect.Bottom - rect.Top;
    if (w < 160 || h < 90) throw new Exception("empty-frame");
    if (w > 8192 || h > 8192 || (long)w*h > 33554432) throw new Exception("capture-failed");
    using (Bitmap original = new Bitmap(w,h,PixelFormat.Format32bppArgb)) {
      using (Graphics graphics = Graphics.FromImage(original)) {
        IntPtr dc = graphics.GetHdc();
        try { if (!PrintWindow(handle, dc, 2)) throw new Exception("capture-failed"); }
        finally { graphics.ReleaseHdc(dc); }
      }
      Check(handle, owner);
      double scale = Math.Min(1.0, Math.Min(1920.0/w,1080.0/h));
      width = Math.Max(1,(int)(w*scale)); height = Math.Max(1,(int)(h*scale));
      using (Bitmap frame = new Bitmap(original,width,height)) {
        int minimum=255, maximum=0;
        for (int y=0;y<45;y++) for (int x=0;x<80;x++) {
          Color c=frame.GetPixel(x*width/80,y*height/45);
          int brightness=(c.R+c.G+c.B)/3;
          minimum=Math.Min(minimum,brightness); maximum=Math.Max(maximum,brightness);
        }
        if (maximum-minimum<8) throw new Exception("empty-frame");
        using (MemoryStream memory = new MemoryStream()) {
          ImageCodecInfo codec=Array.Find(ImageCodecInfo.GetImageEncoders(), c=>c.MimeType=="image/jpeg");
          using (EncoderParameters parameters=new EncoderParameters(1)) {
            parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,85L);
            frame.Save(memory,codec,parameters);
          }
          if (memory.Length<1 || memory.Length>6291456) throw new Exception("capture-failed");
          return memory.ToArray();
        }
      }
    }
  }
}
'@
function Assert-GameIdentity($gameHandle,$gameProcessId) {
  [WarcraftWindowCapture]::Check($gameHandle,$gameProcessId)
  $observedProcess = Get-Process -Id $gameProcessId -ErrorAction Stop
  if ($observedProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:DSH_WOW_START -or -not [string]::Equals($observedProcess.Path,$env:DSH_WOW_PATH,[StringComparison]::OrdinalIgnoreCase)) { throw 'window-changed' }
}
try {
  if ($env:DSH_WOW_HANDLE -notmatch '^[1-9][0-9]{0,18}$' -or $env:DSH_WOW_PID -notmatch '^[1-9][0-9]{0,9}$' -or $env:DSH_WOW_START -notmatch '^[0-9]{1,20}$') { throw 'window-changed' }
  $gameHandle = [IntPtr]([long]::Parse($env:DSH_WOW_HANDLE))
  $gameProcessId = [uint32]::Parse($env:DSH_WOW_PID)
  Assert-GameIdentity $gameHandle $gameProcessId
  $frameWidth = 0; $frameHeight = 0
  $imageBytes = [WarcraftWindowCapture]::Capture($gameHandle,$gameProcessId,[ref]$frameWidth,[ref]$frameHeight)
  Assert-GameIdentity $gameHandle $gameProcessId
  @{ ok=$true; dataUrl=('data:image/jpeg;base64,'+[Convert]::ToBase64String($imageBytes)); width=$frameWidth; height=$frameHeight; capturedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
} catch {
  $failureCode = 'capture-failed'
  foreach ($candidateCode in @('window-changed','minimized-window','empty-frame')) { if ($_.Exception.ToString().Contains($candidateCode)) { $failureCode=$candidateCode; break } }
  @{ ok=$false; code=$failureCode } | ConvertTo-Json -Compress
}
`;
