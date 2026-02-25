import * as vscode from "vscode";
import { BridgeController } from "./bridgeController";
import { discoverAppServerAttachUrl } from "./appServerDiscovery";
import { Logger } from "./logger";

let controller: BridgeController | null = null;
let logger: Logger | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VSC Codex Bridge");
  logger = new Logger(output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "vscCodexBridge.showStatus";
  statusBar.show();

  const extensionVersion = context.extension.packageJSON.version as string;
  controller = new BridgeController(extensionVersion, logger, statusBar);

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("vscCodexBridge.startBridge", async () => {
      if (!controller) {
        return;
      }

      try {
        await controller.start();
        vscode.window.showInformationMessage("VSC Codex Bridge started.");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start bridge: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vscCodexBridge.stopBridge", async () => {
      if (!controller) {
        return;
      }

      await controller.stop();
      vscode.window.showInformationMessage("VSC Codex Bridge stopped.");
    }),
    vscode.commands.registerCommand("vscCodexBridge.restartBridge", async () => {
      if (!controller) {
        return;
      }

      try {
        await controller.restart();
        vscode.window.showInformationMessage("VSC Codex Bridge restarted.");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to restart bridge: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vscCodexBridge.showStatus", () => {
      if (!controller) {
        return;
      }
      const summary = controller.getStatusSummary();
      logger?.show();
      logger?.info(`Status requested:\n${summary}`);
      void vscode.window.showInformationMessage(summary.replace(/\n/g, " | "));
    }),
    vscode.commands.registerCommand("vscCodexBridge.healthCheck", () => {
      if (!controller) {
        return;
      }

      const diagnostics = controller.getDiagnostics();
      logger?.show();
      logger?.info(`Health check:\n${JSON.stringify(diagnostics, null, 2)}`);
      void vscode.window.showInformationMessage("Bridge health check logged in output channel.");
    }),
    vscode.commands.registerCommand("vscCodexBridge.autoDetectAppServerAttachUrl", async () => {
      const detectedUrl = await discoverAppServerAttachUrl();
      if (!detectedUrl) {
        void vscode.window.showWarningMessage("No running local codex app-server was auto-detected.");
        return;
      }

      const config = vscode.workspace.getConfiguration("vscCodexBridge");
      await config.update("appServerAttachUrl", detectedUrl, vscode.ConfigurationTarget.Workspace);
      await config.update("appServerMode", "attach", vscode.ConfigurationTarget.Workspace);

      logger?.show();
      logger?.info(`Auto-detected app-server attach URL: ${detectedUrl}`);

      if (!controller || !controller.isRunning()) {
        void vscode.window.showInformationMessage(`Detected app-server URL and saved attach mode: ${detectedUrl}`);
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Detected app-server URL: ${detectedUrl}`,
        "Restart Bridge",
        "Later",
      );

      if (action !== "Restart Bridge") {
        return;
      }

      try {
        await controller.restart();
        void vscode.window.showInformationMessage("Bridge restarted with attach mode.");
      } catch (error) {
        void vscode.window.showErrorMessage(`Bridge restart failed: ${String(error)}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("vscCodexBridge")) {
        return;
      }

      if (!controller) {
        return;
      }

      try {
        await controller.reloadConfigAndRestartIfRunning();
      } catch (error) {
        logger?.error(`Configuration reload failed: ${String(error)}`);
      }
    }),
    {
      dispose: () => {
        void controller?.stop();
      },
    },
  );

  if (controller.shouldAutoStart()) {
    try {
      await controller.start();
    } catch (error) {
      logger.error(`Bridge auto-start failed: ${String(error)}`);
    }
  } else {
    logger.info("Bridge auto-start is disabled by configuration.");
  }
}

export async function deactivate(): Promise<void> {
  await controller?.stop();
  controller = null;

  logger?.dispose();
  logger = null;
}
