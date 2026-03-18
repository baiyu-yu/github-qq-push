export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

const MAX_LOGS = 1000;
const logs: LogEntry[] = [];

function pad(n: number) {
  return n < 10 ? "0" + n : n;
}

function getTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function addLog(level: LogLevel, ...args: any[]) {
  const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  const entry: LogEntry = {
    timestamp: getTimestamp(),
    level,
    message,
  };
  
  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
}

export function getLogs(): LogEntry[] {
  return logs;
}

export function initLogger() {
  // Capture native console methods
  const ogLog = console.log;
  const ogWarn = console.warn;
  const ogError = console.error;
  const ogDebug = console.debug; // Some might use debug

  console.log = function (...args: any[]) {
    addLog("INFO", ...args);
    ogLog.apply(console, args);
  };
  
  console.info = console.log;

  console.warn = function (...args: any[]) {
    addLog("WARN", ...args);
    ogWarn.apply(console, args);
  };

  console.error = function (...args: any[]) {
    addLog("ERROR", ...args);
    ogError.apply(console, args);
  };

  console.debug = function (...args: any[]) {
    addLog("DEBUG", ...args);
    if (ogDebug) ogDebug.apply(console, args);
    else ogLog.apply(console, args);
  };
}
