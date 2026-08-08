import { execFile } from "node:child_process";

export type WorkspacePickerResult =
  | { status: "selected"; workspace: string }
  | { status: "cancelled" }
  | { status: "unavailable"; message: string }
  | { status: "failed"; message: string };

export interface WorkspacePicker {
  readonly available: boolean;
  select(): Promise<WorkspacePickerResult>;
}

export type PickerRunner = (
  command: string,
  args: string[],
  options: { windowsHide: true; timeout: number },
) => Promise<string>;

export class PlatformWorkspacePicker implements WorkspacePicker {
  readonly available: boolean;

  constructor(
    platform = process.platform,
    private readonly run: PickerRunner = runPicker,
  ) {
    this.available = platform === "win32";
  }

  async select(): Promise<WorkspacePickerResult> {
    if (!this.available)
      return {
        status: "unavailable",
        message: "Folder browsing is available on Windows. Enter an absolute Workspace path instead.",
      };

    const launch = folderPickerLaunch();
    try {
      const output = (
        await this.run(launch.command, launch.args, { windowsHide: true, timeout: 120_000 })
      ).trim();
      return output ? { status: "selected", workspace: output } : { status: "cancelled" };
    } catch {
      return {
        status: "failed",
        message: "The Windows folder picker could not open. Enter an absolute Workspace path instead.",
      };
    }
  }
}

export function folderPickerLaunch(platform = process.platform): { command: string; args: string[] } {
  if (platform !== "win32") throw new Error("Native folder browsing is unavailable on this platform.");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$picker = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$picker.Description = 'Choose a Norvyn Workspace'",
    "$picker.ShowNewFolderButton = $true",
    "if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::Out.Write($picker.SelectedPath)",
    "}",
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
  };
}

function runPicker(
  command: string,
  args: string[],
  options: { windowsHide: true; timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
