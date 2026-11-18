import { spawn } from "node:child_process";
import type { CdpProcessInfo, ModalDialogInfo } from "../types/index.js";

export const WIN32_SCANNER_MAX_TIMEOUT_MS = 3000;
export const DEFAULT_LCEDA_PROCESS_NAME = "lceda-pro.exe";

export interface Win32WindowRecord {
  hwnd: string;
  pid: number;
  title: string;
  className: string;
  isVisible: boolean;
  isForeground: boolean;
  zOrder: number;
  isDialog32770: boolean;
  dialogButtons: string[];
  dialogTexts: string[];
}

export interface Win32ScanSnapshot {
  platformSupported: boolean;
  processes: CdpProcessInfo[];
  windows: Win32WindowRecord[];
  modalDialogs: ModalDialogInfo[];
  timedOut: boolean;
  warning?: string;
}

export interface PowerShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type PowerShellRunner = (
  script: string,
  timeoutMs: number
) => Promise<PowerShellExecResult>;

export interface Win32ScanOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  processName?: string;
  execPowerShell?: PowerShellRunner;
}

interface RawPsProcess {
  pid?: number;
  exePath?: string | null;
  commandLine?: string | null;
}

interface RawPsWindow {
  hwnd?: string;
  pid?: number;
  title?: string;
  className?: string;
  isVisible?: boolean;
  isForeground?: boolean;
  zOrder?: number;
  isDialog32770?: boolean;
  dialogButtons?: string[] | string;
  dialogTexts?: string[] | string;
}

interface RawPsSnapshot {
  mainProcesses?: RawPsProcess[] | RawPsProcess;
  windows?: RawPsWindow[] | RawPsWindow;
}

/**
 * Extract `--remote-debugging-port=<port>` from an Electron process command line.
 */
export function extractCdpPortFromCommandLine(
  commandLine?: string | null
): number | null {
  if (!commandLine) {
    return null;
  }
  const match = commandLine.match(/--remote-debugging-port=(\d+)/i);
  if (!match) {
    return null;
  }
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Extract `--user-data-dir=<dir>` (quoted or unquoted) from a command line.
 */
export function extractUserDataDirFromCommandLine(
  commandLine?: string | null
): string | null {
  if (!commandLine) {
    return null;
  }
  const quoted = commandLine.match(/--user-data-dir="([^"]+)"/i);
  if (quoted) {
    return quoted[1];
  }
  const singleQuoted = commandLine.match(/--user-data-dir='([^']+)'/i);
  if (singleQuoted) {
    return singleQuoted[1];
  }
  const unquoted = commandLine.match(/--user-data-dir=([^\s]+)/i);
  return unquoted ? unquoted[1] : null;
}

function asArray<T>(value: T[] | T | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildPowerShellWin32Script(processName: string): string {
  const safeName = processName.replace(/[^a-zA-Z0-9._-]/g, "");
  return `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
$targetProcName = '${safeName}'
$procs = @(Get-CimInstance Win32_Process -Filter "Name = '$targetProcName'" | Select-Object ProcessId, ExecutablePath, CommandLine)
$allPids = @($procs | ForEach-Object { [int]$_.ProcessId })
$mainProcs = @($procs | Where-Object { [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object {
  [PSCustomObject]@{
    pid = [int]$_.ProcessId
    exePath = $_.ExecutablePath
    commandLine = $_.CommandLine
  }
})

$windows = @()
if ($allPids.Count -gt 0) {
  if (-not ([System.Management.Automation.PSTypeName]'JlcWin32Scanner').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class JlcWin32Scanner {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumThreadWindows(uint dwThreadId, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hwndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public sealed class WinInfo {
        public string hwnd;
        public int pid;
        public string title;
        public string className;
        public bool isVisible;
        public bool isForeground;
        public int zOrder;
        public bool isDialog32770;
        public List<string> dialogButtons;
        public List<string> dialogTexts;
    }

    private static string ReadText(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string ReadClass(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(128);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static WinInfo BuildInfo(IntPtr hWnd, int pid, IntPtr fg, int zOrder, string cls) {
        WinInfo info = new WinInfo();
        info.hwnd = "0x" + hWnd.ToInt64().ToString("X");
        info.pid = pid;
        info.title = ReadText(hWnd);
        info.className = cls;
        info.isVisible = IsWindowVisible(hWnd);
        info.isForeground = (hWnd == fg);
        info.zOrder = zOrder;
        info.isDialog32770 = (cls == "#32770");
        info.dialogButtons = new List<string>();
        info.dialogTexts = new List<string>();

        if (info.isDialog32770 && info.isVisible) {
            EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lp) {
                string cCls = ReadClass(child);
                string cTxt = ReadText(child);
                if (!string.IsNullOrWhiteSpace(cTxt)) {
                    if (cCls.Equals("Button", StringComparison.OrdinalIgnoreCase)) {
                        info.dialogButtons.Add(cTxt.Trim());
                    } else {
                        info.dialogTexts.Add(cTxt.Trim());
                    }
                }
                return true;
            }, IntPtr.Zero);
        }
        return info;
    }

    public static List<WinInfo> Scan(int[] pids) {
        HashSet<int> pidSet = new HashSet<int>(pids);
        List<WinInfo> list = new List<WinInfo>();
        HashSet<long> seenHwnds = new HashSet<long>();
        IntPtr fg = GetForegroundWindow();
        int zIndex = 0;

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint wp = 0;
            GetWindowThreadProcessId(hWnd, out wp);
            int pid = unchecked((int)wp);
            if (!pidSet.Contains(pid)) {
                return true;
            }
            if (!IsWindowVisible(hWnd)) {
                return true;
            }
            string cls = ReadClass(hWnd);
            long key = hWnd.ToInt64();
            if (seenHwnds.Add(key)) {
                list.Add(BuildInfo(hWnd, pid, fg, zIndex++, cls));
            }
            return true;
        }, IntPtr.Zero);

        foreach (int pid in pidSet) {
            try {
                Process p = Process.GetProcessById(pid);
                foreach (ProcessThread th in p.Threads) {
                    EnumThreadWindows((uint)th.Id, delegate(IntPtr hWnd, IntPtr lParam) {
                        if (!IsWindowVisible(hWnd)) {
                            return true;
                        }
                        string cls = ReadClass(hWnd);
                        if (cls != "#32770") {
                            return true;
                        }
                        long key = hWnd.ToInt64();
                        if (seenHwnds.Add(key)) {
                            list.Add(BuildInfo(hWnd, pid, fg, zIndex++, cls));
                        }
                        return true;
                    }, IntPtr.Zero);
                }
            } catch {
                // Ignore exited processes
            }
        }
        return list;
    }
}
"@
  }
  $windows = @([JlcWin32Scanner]::Scan([int[]]$allPids))
}

[PSCustomObject]@{
  mainProcesses = $mainProcs
  windows = $windows
} | ConvertTo-Json -Depth 5 -Compress
`.trim();
}

function killProcessTreeBestEffort(pid?: number): void {
  if (!pid || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // Ignore best-effort cleanup error
    }
  }
}

export async function defaultPowerShellRunner(
  script: string,
  timeoutMs: number
): Promise<PowerShellExecResult> {
  const clampedMs = Math.min(
    Math.max(100, timeoutMs),
    WIN32_SCANNER_MAX_TIMEOUT_MS
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise<PowerShellExecResult>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: PowerShellExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill error
      }
      killProcessTreeBestEffort(child.pid);
      finish({
        stdout,
        stderr: stderr || `PowerShell Win32 scan timed out after ${clampedMs}ms`,
        exitCode: null,
        timedOut: true,
      });
    }, clampedMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish({
        stdout,
        stderr: err.message,
        exitCode: null,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      finish({
        stdout,
        stderr,
        exitCode: code,
        timedOut: false,
      });
    });
  });
}

function parseSnapshotOutput(rawText: string): RawPsSnapshot | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as RawPsSnapshot;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as RawPsSnapshot;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Scan running JLCEDA Pro (`lceda-pro.exe`) main processes, window Z-Order,
 * foreground state, and native `#32770` blocking modal dialogs using Win32 APIs
 * under a strict <= 3s hard timeout. Gracefully returns empty results on non-Windows.
 */
export async function scanLcedaWin32State(
  options: Win32ScanOptions = {}
): Promise<Win32ScanSnapshot> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      platformSupported: false,
      processes: [],
      windows: [],
      modalDialogs: [],
      timedOut: false,
    };
  }

  const timeoutMs = Math.min(
    Math.max(100, options.timeoutMs ?? 2800),
    WIN32_SCANNER_MAX_TIMEOUT_MS
  );
  const processName = options.processName ?? DEFAULT_LCEDA_PROCESS_NAME;
  const runner = options.execPowerShell ?? defaultPowerShellRunner;
  const script = buildPowerShellWin32Script(processName);

  const execResult = await runner(script, timeoutMs);
  if (execResult.timedOut) {
    return {
      platformSupported: true,
      processes: [],
      windows: [],
      modalDialogs: [],
      timedOut: true,
      warning: `Win32 window scan exceeded hard timeout (${timeoutMs}ms).`,
    };
  }

  const parsed = parseSnapshotOutput(execResult.stdout);
  if (!parsed) {
    return {
      platformSupported: true,
      processes: [],
      windows: [],
      modalDialogs: [],
      timedOut: false,
      warning: execResult.stderr.trim() || undefined,
    };
  }

  const rawProcs = asArray(parsed.mainProcesses);
  const rawWindows = asArray(parsed.windows);

  const windows: Win32WindowRecord[] = rawWindows
    .filter((w): w is RawPsWindow => typeof w === "object" && w !== null)
    .map((w, idx) => ({
      hwnd: String(w.hwnd ?? ""),
      pid: typeof w.pid === "number" ? w.pid : 0,
      title: String(w.title ?? ""),
      className: String(w.className ?? ""),
      isVisible: Boolean(w.isVisible),
      isForeground: Boolean(w.isForeground),
      zOrder: typeof w.zOrder === "number" ? w.zOrder : idx,
      isDialog32770: Boolean(w.isDialog32770 || w.className === "#32770"),
      dialogButtons: asArray(w.dialogButtons).map((b) => String(b)),
      dialogTexts: asArray(w.dialogTexts).map((t) => String(t)),
    }))
    .sort((a, b) => a.zOrder - b.zOrder);

  const modalDialogs: ModalDialogInfo[] = windows
    .filter((w) => w.isDialog32770 && w.isVisible)
    .map((w) => ({
      source: "win32",
      title: w.title || "Windows Native Dialog (#32770)",
      textSummary: w.dialogTexts.join(" | ") || w.title || "Blocking native dialog",
      buttons: w.dialogButtons,
      hwnd: w.hwnd,
    }));

  const primaryWindowByPid = new Map<number, Win32WindowRecord>();
  for (const win of windows) {
    if (win.isDialog32770 || !win.isVisible) {
      continue;
    }
    const existing = primaryWindowByPid.get(win.pid);
    if (!existing || win.zOrder < existing.zOrder) {
      primaryWindowByPid.set(win.pid, win);
    }
  }

  const processes: CdpProcessInfo[] = rawProcs
    .filter((p): p is RawPsProcess => typeof p.pid === "number" && p.pid > 0)
    .map((p, idx) => {
      const pid = p.pid!;
      const cmd = p.commandLine ?? null;
      const cdpPort = extractCdpPortFromCommandLine(cmd);
      const userDataDir = extractUserDataDirFromCommandLine(cmd);
      const win = primaryWindowByPid.get(pid);
      return {
        pid,
        exePath: p.exePath ?? null,
        commandLine: cmd,
        hasCdp: cdpPort !== null,
        cdpPort,
        userDataDir,
        windowTitle: win?.title ?? "",
        hwnd: win?.hwnd ?? null,
        zOrder: win?.zOrder ?? 1000 + idx,
        isForeground: win?.isForeground ?? false,
      };
    })
    .sort((a, b) => a.zOrder - b.zOrder);

  return {
    platformSupported: true,
    processes,
    windows,
    modalDialogs,
    timedOut: false,
  };
}

export async function scanWin32Processes(
  options?: Win32ScanOptions
): Promise<CdpProcessInfo[]> {
  const snapshot = await scanLcedaWin32State(options);
  return snapshot.processes;
}

export async function scanWin32ModalDialogs(
  options?: Win32ScanOptions
): Promise<ModalDialogInfo[]> {
  const snapshot = await scanLcedaWin32State(options);
  return snapshot.modalDialogs;
}
