"use strict";

try {
  const { contextBridge, ipcRenderer } = require("electron");

  contextBridge.exposeInMainWorld("bridgeHub", {
    getState: () => ipcRenderer.invoke("menubar:get-state"),
    getConfig: () => ipcRenderer.invoke("menubar:get-config"),
    getAppSettings: () => ipcRenderer.invoke("menubar:get-app-settings"),
    saveConfig: (patch) => ipcRenderer.invoke("menubar:save-config", patch),
    saveAppSettings: (patch) => ipcRenderer.invoke("menubar:save-app-settings", patch),
    getDiagnostics: (options) => ipcRenderer.invoke("menubar:get-diagnostics", options),
    runAction: (action) => ipcRenderer.invoke("menubar:action", action),
    onBootstrap: (listener) => {
      if (typeof listener !== "function") {
        return () => {};
      }

      const wrapped = (_event, payload) => {
        listener(payload);
      };
      ipcRenderer.on("menubar:bootstrap", wrapped);
      return () => {
        ipcRenderer.removeListener("menubar:bootstrap", wrapped);
      };
    },
    onStateChanged: (listener) => {
      if (typeof listener !== "function") {
        return () => {};
      }

      const wrapped = (_event, payload) => {
        listener(payload);
      };
      ipcRenderer.on("menubar:state-changed", wrapped);
      return () => {
        ipcRenderer.removeListener("menubar:state-changed", wrapped);
      };
    },
  });

  console.log("[control-center preload] bridgeHub exposed");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[control-center preload] failed: ${message}`);
}
