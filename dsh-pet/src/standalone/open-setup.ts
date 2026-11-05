/** Open only the authenticated local settings URL; never log its capability token. */
import { execFile } from 'node:child_process';

export function openSetup(url: string): void {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(command as string, args as string[], { windowsHide: true }, () => {
    /* The pet menu remains available if no browser is installed. */
  });
}
