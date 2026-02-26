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
  statusBar.command = "vscCodexBridge.controlPanel";
  statusBar.show();

  const extensionVersion = context.extension.packageJSON.version as string;
  controller = new BridgeController(extensionVersion, context, logger, statusBar);

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
    vscode.commands.registerCommand("vscCodexBridge.startHub", async () => {
      if (!controller) {
        return;
      }

      try {
        await controller.startManagedHub();
        vscode.window.showInformationMessage("Managed hub started.");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to start managed hub: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vscCodexBridge.stopHub", async () => {
      if (!controller) {
        return;
      }

      try {
        await controller.stopManagedHub();
        vscode.window.showInformationMessage("Managed hub stopped.");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to stop managed hub: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vscCodexBridge.restartHub", async () => {
      if (!controller) {
        return;
      }

      try {
        await controller.restartManagedHub();
        vscode.window.showInformationMessage("Managed hub restarted.");
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to restart managed hub: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("vscCodexBridge.openPwa", async () => {
      if (!controller) {
        return;
      }

      const url = controller.getPwaUrl();
      await vscode.env.openExternal(vscode.Uri.parse(url));
      vscode.window.showInformationMessage(`Opened PWA: ${url}`);
    }),
    vscode.commands.registerCommand("vscCodexBridge.controlPanel", async () => {
      if (!controller) {
        return;
      }

      const selected = await vscode.window.showQuickPick(
        [
          { label: "Open PWA", action: "open-pwa" },
          { label: "Start Bridge", action: "start-bridge" },
          { label: "Stop Bridge", action: "stop-bridge" },
          { label: "Restart Bridge", action: "restart-bridge" },
          { label: "Start Hub", action: "start-hub" },
          { label: "Stop Hub", action: "stop-hub" },
          { label: "Restart Hub", action: "restart-hub" },
          { label: "Show Status", action: "show-status" },
          { label: "Health Check", action: "health-check" },
          { label: "Self Check", action: "self-check" },
        ],
        {
          title: "VSC Codex Bridge Control",
          placeHolder: "Choose an action",
        },
      );

      if (!selected) {
        return;
      }

      switch (selected.action) {
        case "open-pwa":
          await vscode.commands.executeCommand("vscCodexBridge.openPwa");
          break;
        case "start-bridge":
          await vscode.commands.executeCommand("vscCodexBridge.startBridge");
          break;
        case "stop-bridge":
          await vscode.commands.executeCommand("vscCodexBridge.stopBridge");
          break;
        case "restart-bridge":
          await vscode.commands.executeCommand("vscCodexBridge.restartBridge");
          break;
        case "start-hub":
          await vscode.commands.executeCommand("vscCodexBridge.startHub");
          break;
        case "stop-hub":
          await vscode.commands.executeCommand("vscCodexBridge.stopHub");
          break;
        case "restart-hub":
          await vscode.commands.executeCommand("vscCodexBridge.restartHub");
          break;
        case "show-status":
          await vscode.commands.executeCommand("vscCodexBridge.showStatus");
          break;
        case "health-check":
          await vscode.commands.executeCommand("vscCodexBridge.healthCheck");
          break;
        case "self-check":
          await vscode.commands.executeCommand("vscCodexBridge.selfCheck");
          break;
        default:
          break;
      }
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
    vscode.commands.registerCommand("vscCodexBridge.selfCheck", () => {
      if (!controller) {
        return;
      }

      const diagnostics = controller.getDiagnostics() as Record<string, unknown>;
      const config = (diagnostics.config ?? {}) as Record<string, unknown>;
      const issues: string[] = [];

      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        issues.push("No workspace folder is open.");
      }

      if (String(config.appServerMode ?? "") === "attach" && !String(config.appServerAttachUrl ?? "")) {
        issues.push("Attach mode is enabled but appServerAttachUrl is empty.");
      }

      if (Boolean(config.manageHubInExtension) && !String(config.hubUrl ?? "").startsWith("http://")) {
        issues.push("Managed hub is enabled but resolved hub URL is invalid.");
      }

      if (!Boolean(config.manageHubInExtension) && !String(config.hubUrl ?? "").trim()) {
        issues.push("External hub URL is empty while managed hub is disabled.");
      }

      logger?.show();
      logger?.info(`Self check diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);

      if (issues.length === 0) {
        void vscode.window.showInformationMessage("Self check: OK. No obvious configuration issues detected.");
        return;
      }

      logger?.warn(`Self check issues:\n- ${issues.join("\n- ")}`);
      void vscode.window.showWarningMessage(`Self check found ${issues.length} issue(s). See output channel.`);
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
