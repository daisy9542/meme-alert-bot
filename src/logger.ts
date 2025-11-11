import pino from "pino";

/** 生产 & 开发友好的日志器 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
});
