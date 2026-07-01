type LogLevel = "info" | "warn" | "error" | "debug";

function ts(): string {
  return new Date().toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function log(level: LogLevel, msg: string, extra?: unknown) {
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  if (extra !== undefined) {
    console.log(prefix, msg, extra);
  } else {
    console.log(prefix, msg);
  }
}

export const logger = {
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (process.env.DEBUG) log("debug", msg, extra);
  },
};
