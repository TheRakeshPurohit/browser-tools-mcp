#!/usr/bin/env node

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { tokenizeAndEstimateCost } from "llm-cost";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { IncomingMessage } from "http";
import { Socket } from "net";
import os from "os";
import { runPerformanceAudit } from "./lighthouse/performance.js";
import { runAccessibilityAudit } from "./lighthouse/accessibility.js";

// Function to get default downloads folder
function getDefaultDownloadsFolder(): string {
  const homeDir = os.homedir();
  // Downloads folder is typically the same path on Windows, macOS, and Linux
  const downloadsPath = path.join(homeDir, "Downloads", "mcp-screenshots");
  return downloadsPath;
}

// We store logs in memory
const consoleLogs: any[] = [];
const consoleErrors: any[] = [];
const networkErrors: any[] = [];
const networkSuccess: any[] = [];
const allXhr: any[] = [];

// Store the current URL from the extension
let currentUrl: string = "";

// Add settings state
let currentSettings = {
  logLimit: 50,
  queryLimit: 30000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  model: "claude-3-sonnet",
  stringSizeLimit: 500,
  maxLogSize: 20000,
  screenshotPath: getDefaultDownloadsFolder(),
};

// Add new storage for selected element
let selectedElement: any = null;

// Add new state for tracking screenshot requests
interface ScreenshotCallback {
  resolve: (value: { data: string; path?: string }) => void;
  reject: (reason: Error) => void;
}

const screenshotCallbacks = new Map<string, ScreenshotCallback>();

const app = express();
const PORT = 3025;

app.use(cors());
// Increase JSON body parser limit to 50MB to handle large screenshots
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Helper to recursively truncate strings in any data structure
function truncateStringsInData(data: any, maxLength: number): any {
  if (typeof data === "string") {
    return data.length > maxLength
      ? data.substring(0, maxLength) + "... (truncated)"
      : data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => truncateStringsInData(item, maxLength));
  }

  if (typeof data === "object" && data !== null) {
    const result: any = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = truncateStringsInData(value, maxLength);
    }
    return result;
  }

  return data;
}

// Helper to safely parse and process JSON strings
function processJsonString(jsonString: string, maxLength: number): string {
  try {
    // Try to parse the string as JSON
    const parsed = JSON.parse(jsonString);
    // Process any strings within the parsed JSON
    const processed = truncateStringsInData(parsed, maxLength);
    // Stringify the processed data
    return JSON.stringify(processed);
  } catch (e) {
    // If it's not valid JSON, treat it as a regular string
    return truncateStringsInData(jsonString, maxLength);
  }
}

// Helper to process logs based on settings
function processLogsWithSettings(logs: any[]) {
  return logs.map((log) => {
    const processedLog = { ...log };

    if (log.type === "network-request") {
      // Handle headers visibility
      if (!currentSettings.showRequestHeaders) {
        delete processedLog.requestHeaders;
      }
      if (!currentSettings.showResponseHeaders) {
        delete processedLog.responseHeaders;
      }
    }

    return processedLog;
  });
}

// Helper to calculate size of a log entry
function calculateLogSize(log: any): number {
  return JSON.stringify(log).length;
}

// Helper to truncate logs based on character limit
function truncateLogsToQueryLimit(logs: any[]): any[] {
  if (logs.length === 0) return logs;

  // First process logs according to current settings
  const processedLogs = processLogsWithSettings(logs);

  let currentSize = 0;
  const result = [];

  for (const log of processedLogs) {
    const logSize = calculateLogSize(log);

    // Check if adding this log would exceed the limit
    if (currentSize + logSize > currentSettings.queryLimit) {
      console.log(
        `Reached query limit (${currentSize}/${currentSettings.queryLimit}), truncating logs`
      );
      break;
    }

    // Add log and update size
    result.push(log);
    currentSize += logSize;
    console.log(`Added log of size ${logSize}, total size now: ${currentSize}`);
  }

  return result;
}

// Endpoint for the extension to POST data
app.post("/extension-log", (req, res) => {
  console.log("\n=== Received Extension Log ===");
  console.log("Request body:", {
    dataType: req.body.data?.type,
    timestamp: req.body.data?.timestamp,
    hasSettings: !!req.body.settings,
  });

  const { data, settings } = req.body;

  // Update settings if provided
  if (settings) {
    console.log("Updating settings:", settings);
    currentSettings = {
      ...currentSettings,
      ...settings,
    };
  }

  if (!data) {
    console.log("Warning: No data received in log request");
    res.status(400).json({ status: "error", message: "No data provided" });
    return;
  }

  console.log(`Processing ${data.type} log entry`);

  switch (data.type) {
    case "page-navigated":
      // Handle page navigation event via HTTP POST
      // Note: This is also handled in the WebSocket message handler
      // as the extension may send navigation events through either channel
      console.log("Received page navigation event with URL:", data.url);
      currentUrl = data.url;
      console.log("Updated current URL:", currentUrl);
      break;
    case "console-log":
      console.log("Adding console log:", {
        level: data.level,
        message:
          data.message?.substring(0, 100) +
          (data.message?.length > 100 ? "..." : ""),
        timestamp: data.timestamp,
      });
      consoleLogs.push(data);
      if (consoleLogs.length > currentSettings.logLimit) {
        console.log(
          `Console logs exceeded limit (${currentSettings.logLimit}), removing oldest entry`
        );
        consoleLogs.shift();
      }
      break;
    case "console-error":
      console.log("Adding console error:", {
        level: data.level,
        message:
          data.message?.substring(0, 100) +
          (data.message?.length > 100 ? "..." : ""),
        timestamp: data.timestamp,
      });
      consoleErrors.push(data);
      if (consoleErrors.length > currentSettings.logLimit) {
        console.log(
          `Console errors exceeded limit (${currentSettings.logLimit}), removing oldest entry`
        );
        consoleErrors.shift();
      }
      break;
    case "network-request":
      const logEntry = {
        url: data.url,
        method: data.method,
        status: data.status,
        timestamp: data.timestamp,
      };
      console.log("Adding network request:", logEntry);

      // Route network requests based on status code
      if (data.status >= 400) {
        networkErrors.push(data);
        if (networkErrors.length > currentSettings.logLimit) {
          console.log(
            `Network errors exceeded limit (${currentSettings.logLimit}), removing oldest entry`
          );
          networkErrors.shift();
        }
      } else {
        networkSuccess.push(data);
        if (networkSuccess.length > currentSettings.logLimit) {
          console.log(
            `Network success logs exceeded limit (${currentSettings.logLimit}), removing oldest entry`
          );
          networkSuccess.shift();
        }
      }
      break;
    case "selected-element":
      console.log("Updating selected element:", {
        tagName: data.element?.tagName,
        id: data.element?.id,
        className: data.element?.className,
      });
      selectedElement = data.element;
      break;
    default:
      console.log("Unknown log type:", data.type);
  }

  console.log("Current log counts:", {
    consoleLogs: consoleLogs.length,
    consoleErrors: consoleErrors.length,
    networkErrors: networkErrors.length,
    networkSuccess: networkSuccess.length,
  });
  console.log("=== End Extension Log ===\n");

  res.json({ status: "ok" });
});

// Update GET endpoints to use the new function
app.get("/console-logs", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(consoleLogs);
  res.json(truncatedLogs);
});

app.get("/console-errors", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(consoleErrors);
  res.json(truncatedLogs);
});

app.get("/network-errors", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(networkErrors);
  res.json(truncatedLogs);
});

app.get("/network-success", (req, res) => {
  const truncatedLogs = truncateLogsToQueryLimit(networkSuccess);
  res.json(truncatedLogs);
});

app.get("/all-xhr", (req, res) => {
  // Merge and sort network success and error logs by timestamp
  const mergedLogs = [...networkSuccess, ...networkErrors].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const truncatedLogs = truncateLogsToQueryLimit(mergedLogs);
  res.json(truncatedLogs);
});

// Add new endpoint for selected element
app.post("/selected-element", (req, res) => {
  const { data } = req.body;
  selectedElement = data;
  res.json({ status: "ok" });
});

app.get("/selected-element", (req, res) => {
  res.json(selectedElement || { message: "No element selected" });
});

app.get("/.port", (req, res) => {
  res.send(PORT.toString());
});

// Add function to clear all logs
function clearAllLogs() {
  console.log("Wiping all logs...");
  consoleLogs.length = 0;
  consoleErrors.length = 0;
  networkErrors.length = 0;
  networkSuccess.length = 0;
  allXhr.length = 0;
  selectedElement = null;
  console.log("All logs have been wiped");
}

// Add endpoint to wipe logs
app.post("/wipelogs", (req, res) => {
  clearAllLogs();
  res.json({ status: "ok", message: "All logs cleared successfully" });
});

// Add endpoint for the extension to report the current URL
app.post("/current-url", (req, res) => {
  console.log("Received current URL update:", req.body);

  if (req.body && req.body.url) {
    currentUrl = req.body.url;
    console.log("Updated current URL via dedicated endpoint:", currentUrl);
    res.json({ status: "ok", url: currentUrl });
  } else {
    console.log("No URL provided in current-url request");
    res.status(400).json({ status: "error", message: "No URL provided" });
  }
});

// Add endpoint to get the current URL
app.get("/current-url", (req, res) => {
  console.log("Current URL requested, returning:", currentUrl);
  res.json({ url: currentUrl });
});

interface ScreenshotMessage {
  type: "screenshot-data" | "screenshot-error";
  data?: string;
  path?: string;
  error?: string;
}

export class BrowserConnector {
  private wss: WebSocketServer;
  private activeConnection: WebSocket | null = null;
  private app: express.Application;
  private server: any;
  private urlRequestCallbacks: Map<string, (url: string) => void> = new Map();

  constructor(app: express.Application, server: any) {
    this.app = app;
    this.server = server;

    // Initialize WebSocket server using the existing HTTP server
    this.wss = new WebSocketServer({
      noServer: true,
      path: "/extension-ws",
    });

    // Register the capture-screenshot endpoint
    this.app.post(
      "/capture-screenshot",
      async (req: express.Request, res: express.Response) => {
        console.log(
          "Browser Connector: Received request to /capture-screenshot endpoint"
        );
        console.log("Browser Connector: Request body:", req.body);
        console.log(
          "Browser Connector: Active WebSocket connection:",
          !!this.activeConnection
        );
        await this.captureScreenshot(req, res);
      }
    );

    // Set up accessibility audit endpoint
    this.setupAccessibilityAudit();

    // Set up performance audit endpoint
    this.setupPerformanceAudit();

    // Handle upgrade requests for WebSocket
    this.server.on(
      "upgrade",
      (request: IncomingMessage, socket: Socket, head: Buffer) => {
        if (request.url === "/extension-ws") {
          this.wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            this.wss.emit("connection", ws, request);
          });
        }
      }
    );

    this.wss.on("connection", (ws: WebSocket) => {
      console.log("Chrome extension connected via WebSocket");
      this.activeConnection = ws;

      ws.on("message", (message) => {
        try {
          const data = JSON.parse(message.toString());
          // Log message without the base64 data
          console.log("Received WebSocket message:", {
            ...data,
            data: data.data ? "[base64 data]" : undefined,
          });

          // Handle URL response
          if (data.type === "current-url-response" && data.url) {
            console.log("Received current URL from browser:", data.url);
            currentUrl = data.url;

            // Call the callback if exists
            if (
              data.requestId &&
              this.urlRequestCallbacks.has(data.requestId)
            ) {
              const callback = this.urlRequestCallbacks.get(data.requestId);
              if (callback) callback(data.url);
              this.urlRequestCallbacks.delete(data.requestId);
            }
          }
          // Handle page navigation event via WebSocket
          // Note: This is intentionally duplicated from the HTTP handler in /extension-log
          // as the extension may send navigation events through either channel
          if (data.type === "page-navigated" && data.url) {
            console.log("Page navigated to:", data.url);
            currentUrl = data.url;
          }
          // Handle screenshot response
          if (data.type === "screenshot-data" && data.data) {
            console.log("Received screenshot data");
            console.log("Screenshot path from extension:", data.path);
            // Get the most recent callback since we're not using requestId anymore
            const callbacks = Array.from(screenshotCallbacks.values());
            if (callbacks.length > 0) {
              const callback = callbacks[0];
              console.log("Found callback, resolving promise");
              // Pass both the data and path to the resolver
              callback.resolve({ data: data.data, path: data.path });
              screenshotCallbacks.clear(); // Clear all callbacks
            } else {
              console.log("No callbacks found for screenshot");
            }
          }
          // Handle screenshot error
          else if (data.type === "screenshot-error") {
            console.log("Received screenshot error:", data.error);
            const callbacks = Array.from(screenshotCallbacks.values());
            if (callbacks.length > 0) {
              const callback = callbacks[0];
              callback.reject(
                new Error(data.error || "Screenshot capture failed")
              );
              screenshotCallbacks.clear(); // Clear all callbacks
            }
          } else {
            console.log("Unhandled message type:", data.type);
          }
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
        }
      });

      ws.on("close", () => {
        console.log("Chrome extension disconnected");
        if (this.activeConnection === ws) {
          this.activeConnection = null;
        }
      });
    });

    // Add screenshot endpoint
    this.app.post(
      "/screenshot",
      (req: express.Request, res: express.Response): void => {
        console.log(
          "Browser Connector: Received request to /screenshot endpoint"
        );
        console.log("Browser Connector: Request body:", req.body);
        try {
          console.log("Received screenshot capture request");
          const { data, path: outputPath } = req.body;

          if (!data) {
            console.log("Screenshot request missing data");
            res.status(400).json({ error: "Missing screenshot data" });
            return;
          }

          // Use provided path or default to downloads folder
          const targetPath = outputPath || getDefaultDownloadsFolder();
          console.log(`Using screenshot path: ${targetPath}`);

          // Remove the data:image/png;base64, prefix
          const base64Data = data.replace(/^data:image\/png;base64,/, "");

          // Create the full directory path if it doesn't exist
          fs.mkdirSync(targetPath, { recursive: true });
          console.log(`Created/verified directory: ${targetPath}`);

          // Generate a unique filename using timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = `screenshot-${timestamp}.png`;
          const fullPath = path.join(targetPath, filename);
          console.log(`Saving screenshot to: ${fullPath}`);

          // Write the file
          fs.writeFileSync(fullPath, base64Data, "base64");
          console.log("Screenshot saved successfully");

          res.json({
            path: fullPath,
            filename: filename,
          });
        } catch (error: unknown) {
          console.error("Error saving screenshot:", error);
          if (error instanceof Error) {
            res.status(500).json({ error: error.message });
          } else {
            res.status(500).json({ error: "An unknown error occurred" });
          }
        }
      }
    );
  }

  private async handleScreenshot(req: express.Request, res: express.Response) {
    if (!this.activeConnection) {
      return res.status(503).json({ error: "Chrome extension not connected" });
    }

    try {
      const result = await new Promise((resolve, reject) => {
        // Set up one-time message handler for this screenshot request
        const messageHandler = (message: WebSocket.Data) => {
          try {
            const response: ScreenshotMessage = JSON.parse(message.toString());

            if (response.type === "screenshot-error") {
              reject(new Error(response.error));
              return;
            }

            if (
              response.type === "screenshot-data" &&
              response.data &&
              response.path
            ) {
              // Remove the data:image/png;base64, prefix
              const base64Data = response.data.replace(
                /^data:image\/png;base64,/,
                ""
              );

              // Ensure the directory exists
              const dir = path.dirname(response.path);
              fs.mkdirSync(dir, { recursive: true });

              // Generate a unique filename using timestamp
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const filename = `screenshot-${timestamp}.png`;
              const fullPath = path.join(response.path, filename);

              // Write the file
              fs.writeFileSync(fullPath, base64Data, "base64");
              resolve({
                path: fullPath,
                filename: filename,
              });
            }
          } catch (error) {
            reject(error);
          } finally {
            this.activeConnection?.removeListener("message", messageHandler);
          }
        };

        // Add temporary message handler
        this.activeConnection?.on("message", messageHandler);

        // Request screenshot
        this.activeConnection?.send(
          JSON.stringify({ type: "take-screenshot" })
        );

        // Set timeout
        setTimeout(() => {
          this.activeConnection?.removeListener("message", messageHandler);
          reject(new Error("Screenshot timeout"));
        }, 30000); // 30 second timeout
      });

      res.json(result);
    } catch (error: unknown) {
      if (error instanceof Error) {
        res.status(500).json({ error: error.message });
      } else {
        res.status(500).json({ error: "An unknown error occurred" });
      }
    }
  }

  // Method to request the current URL from the browser
  private async requestCurrentUrl(): Promise<string | null> {
    if (this.activeConnection) {
      console.log("Requesting current URL from browser via WebSocket...");
      try {
        const requestId = Date.now().toString();

        // Create a promise that will resolve when we get the URL
        const urlPromise = new Promise<string>((resolve, reject) => {
          // Store callback in map
          this.urlRequestCallbacks.set(requestId, resolve);

          // Set a timeout to reject the promise if we don't get a response
          setTimeout(() => {
            if (this.urlRequestCallbacks.has(requestId)) {
              console.log("URL request timed out");
              this.urlRequestCallbacks.delete(requestId);
              reject(new Error("URL request timed out"));
            }
          }, 5000);
        });

        // Send the request to the browser
        this.activeConnection.send(
          JSON.stringify({
            type: "get-current-url",
            requestId,
          })
        );

        // Wait for the response
        const url = await urlPromise;
        return url;
      } catch (error) {
        console.error("Error requesting URL from browser:", error);
        // Fall back to stored URL if available
        if (currentUrl) {
          console.log("Falling back to stored URL:", currentUrl);
          return currentUrl;
        }
        return null;
      }
    } else if (currentUrl) {
      // If no active connection but we have a stored URL, use it as fallback
      console.log(
        "No active connection, using stored URL as fallback:",
        currentUrl
      );
      return currentUrl;
    }

    console.log("No active connection and no stored URL");
    return null;
  }

  // Public method to check if there's an active connection
  public hasActiveConnection(): boolean {
    return this.activeConnection !== null;
  }

  // Add new endpoint for programmatic screenshot capture
  async captureScreenshot(req: express.Request, res: express.Response) {
    console.log("Browser Connector: Starting captureScreenshot method");
    console.log("Browser Connector: Request headers:", req.headers);
    console.log("Browser Connector: Request method:", req.method);

    if (!this.activeConnection) {
      console.log(
        "Browser Connector: No active WebSocket connection to Chrome extension"
      );
      return res.status(503).json({ error: "Chrome extension not connected" });
    }

    try {
      console.log("Browser Connector: Starting screenshot capture...");
      const requestId = Date.now().toString();
      console.log("Browser Connector: Generated requestId:", requestId);

      // Create promise that will resolve when we get the screenshot data
      const screenshotPromise = new Promise<{ data: string; path?: string }>(
        (resolve, reject) => {
          console.log(
            `Browser Connector: Setting up screenshot callback for requestId: ${requestId}`
          );
          // Store callback in map
          screenshotCallbacks.set(requestId, { resolve, reject });
          console.log(
            "Browser Connector: Current callbacks:",
            Array.from(screenshotCallbacks.keys())
          );

          // Set timeout to clean up if we don't get a response
          setTimeout(() => {
            if (screenshotCallbacks.has(requestId)) {
              console.log(
                `Browser Connector: Screenshot capture timed out for requestId: ${requestId}`
              );
              screenshotCallbacks.delete(requestId);
              reject(
                new Error(
                  "Screenshot capture timed out - no response from Chrome extension"
                )
              );
            }
          }, 10000);
        }
      );

      // Send screenshot request to extension
      const message = JSON.stringify({
        type: "take-screenshot",
        requestId: requestId,
      });
      console.log(
        `Browser Connector: Sending WebSocket message to extension:`,
        message
      );
      this.activeConnection.send(message);

      // Wait for screenshot data
      console.log("Browser Connector: Waiting for screenshot data...");
      const { data: base64Data, path: customPath } = await screenshotPromise;
      console.log("Browser Connector: Received screenshot data, saving...");
      console.log("Browser Connector: Custom path from extension:", customPath);

      // Determine target path
      const targetPath =
        customPath ||
        currentSettings.screenshotPath ||
        getDefaultDownloadsFolder();
      console.log(`Browser Connector: Using path: ${targetPath}`);

      if (!base64Data) {
        throw new Error("No screenshot data received from Chrome extension");
      }

      fs.mkdirSync(targetPath, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `screenshot-${timestamp}.png`;
      const fullPath = path.join(targetPath, filename);

      // Remove the data:image/png;base64, prefix if present
      const cleanBase64 = base64Data.replace(/^data:image\/png;base64,/, "");

      // Save the file
      fs.writeFileSync(fullPath, cleanBase64, "base64");
      console.log(`Browser Connector: Screenshot saved to: ${fullPath}`);

      res.json({
        path: fullPath,
        filename: filename,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        "Browser Connector: Error capturing screenshot:",
        errorMessage
      );
      res.status(500).json({
        error: errorMessage,
      });
    }
  }

  // Add a helper method to get the URL for audits
  private async getUrlForAudit(): Promise<string | null> {
    // Wait for WebSocket connection if not already connected
    if (!this.activeConnection) {
      console.log("No active WebSocket connection, waiting for connection...");
      try {
        await this.waitForConnection(15000); // Wait up to 15 seconds for connection
        console.log("WebSocket connection established");
      } catch (error) {
        console.error("Timed out waiting for WebSocket connection");
      }
    }
    console.log("Attempting to get current URL from browser extension");
    const browserUrl = await this.requestCurrentUrl();
    if (browserUrl) {
      try {
        // Validate URL format
        new URL(browserUrl);
        return browserUrl;
      } catch (e) {
        console.error(`Invalid URL format from browser: ${browserUrl}`);
        // Continue to next option
      }
    }

    // Fallback: Use stored URL
    if (currentUrl) {
      try {
        // Validate URL format
        new URL(currentUrl);
        console.log(`Using stored URL as fallback: ${currentUrl}`);
        return currentUrl;
      } catch (e) {
        console.error(`Invalid stored URL format: ${currentUrl}`);
        // Continue to next option
      }
    }

    // Default fallback
    console.error("No valid URL available for audit, using about:blank");
    return "about:blank";
  }

  // Method to wait for WebSocket connection, we need this to ensure the browser extension
  // is connected before we try to get the current URL
  private waitForConnection(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // If already connected, resolve immediately
      if (this.activeConnection) {
        resolve();
        return;
      }

      // Set up a listener for connection
      const connectionListener = (ws: WebSocket) => {
        this.wss.off("connection", connectionListener);
        resolve();
      };

      // Listen for connection event
      this.wss.on("connection", connectionListener);

      // Set timeout
      const timeoutId = setTimeout(() => {
        this.wss.off("connection", connectionListener);
        reject(new Error("Connection timeout"));
      }, timeout);
    });
  }

  // Sets up the accessibility audit endpoint
  private setupAccessibilityAudit() {
    this.app.post("/accessibility-audit", async (req: any, res: any) => {
      try {
        console.log("Accessibility audit request received");

        const limit = req.body?.limit || 5;
        const detailed = req.body?.detailed || false;

        // Get URL using our helper method
        const url = await this.getUrlForAudit();

        if (!url) {
          console.log("No URL available for accessibility audit");
          return res.status(400).json({
            error:
              "URL is required for accessibility audit. Either provide a URL in the request body or navigate to a page in the browser first.",
          });
        }

        // Check if we're using the default URL
        if (url === "about:blank") {
          console.log("Cannot run accessibility audit on about:blank");
          return res.status(400).json({
            error:
              "Cannot run accessibility audit on about:blank. Please provide a valid URL or navigate to a page in the browser first.",
          });
        }

        // Run the audit using the imported function
        try {
          const processedResults = await runAccessibilityAudit(
            url,
            limit,
            detailed
          );

          console.log("Accessibility audit completed successfully");
          // Return the results
          res.json(processedResults);
        } catch (auditError) {
          console.error("Accessibility audit failed:", auditError);
          const errorMessage =
            auditError instanceof Error
              ? auditError.message
              : String(auditError);
          res.status(500).json({
            error: `Failed to run accessibility audit: ${errorMessage}`,
          });
        }
      } catch (error) {
        console.error("Error in accessibility audit endpoint:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        res.status(500).json({
          error: `Error in accessibility audit endpoint: ${errorMessage}`,
        });
      }
    });
  }

  // Sets up the performance audit endpoint
  private setupPerformanceAudit() {
    this.app.post("/performance-audit", async (req: any, res: any) => {
      try {
        console.log("Performance audit request received");

        const limit = req.body?.limit || 5;
        const detailed = req.body?.detailed || false;

        console.log("Performance audit request body:", req.body);
        // Get URL using our helper method
        const url = await this.getUrlForAudit();

        if (!url) {
          console.log("No URL available for performance audit");
          return res.status(400).json({
            error:
              "URL is required for performance audit. Either provide a URL in the request body or navigate to a page in the browser first.",
          });
        }

        // Check if we're using the default URL
        if (url === "about:blank") {
          console.log("Cannot run performance audit on about:blank");
          return res.status(400).json({
            error:
              "Cannot run performance audit on about:blank. Please provide a valid URL or navigate to a page in the browser first.",
          });
        }

        // Run the audit using the imported function
        try {
          const processedResults = await runPerformanceAudit(
            url,
            limit,
            detailed
          );

          console.log("Performance audit completed successfully");
          // Return the results
          res.json(processedResults);
        } catch (auditError) {
          console.error("Performance audit failed:", auditError);
          const errorMessage =
            auditError instanceof Error
              ? auditError.message
              : String(auditError);
          res.status(500).json({
            error: `Failed to run performance audit: ${errorMessage}`,
          });
        }
      } catch (error) {
        console.error("Error in performance audit endpoint:", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        res.status(500).json({
          error: `Error in performance audit endpoint: ${errorMessage}`,
        });
      }
    });
  }
}

// Move the server creation before BrowserConnector instantiation
const server = app.listen(PORT, () => {
  console.log(`Aggregator listening on http://127.0.0.1:${PORT}`);
});

// Initialize the browser connector with the existing app AND server
const browserConnector = new BrowserConnector(app, server);

// Handle shutdown gracefully
process.on("SIGINT", () => {
  server.close(() => {
    console.log("Server shut down");
    process.exit(0);
  });
});
