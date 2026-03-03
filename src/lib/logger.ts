/**
 * Structured logging for production debugging and audit trails.
 * Logs are JSON-formatted for easy ingestion by logging services (e.g., CloudWatch, Datadog).
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  tableId?: string;
  handId?: string;
  userId?: string;
  seatNo?: number;
  action?: string;
  amount?: number;
  event?: string;
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private isProduction: boolean;

  constructor() {
    this.level = (process.env.LOG_LEVEL as LogLevel) ?? "info";
    this.isProduction = process.env.NODE_ENV === "production";
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private format(level: LogLevel, message: string, context?: LogContext): string {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    if (this.isProduction) {
      // Production: JSON for log aggregators
      return JSON.stringify(entry);
    } else {
      // Development: human-readable
      const ctx = context ? ` ${JSON.stringify(context)}` : "";
      return `[${entry.timestamp}] ${level.toUpperCase()}: ${message}${ctx}`;
    }
  }

  debug(message: string, context?: LogContext) {
    if (this.shouldLog("debug")) {
      console.log(this.format("debug", message, context));
    }
  }

  info(message: string, context?: LogContext) {
    if (this.shouldLog("info")) {
      console.log(this.format("info", message, context));
    }
  }

  warn(message: string, context?: LogContext) {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", message, context));
    }
  }

  error(message: string, context?: LogContext) {
    if (this.shouldLog("error")) {
      console.error(this.format("error", message, context));
    }
  }

  // Specialized loggers for common events
  handStarted(tableId: string, handId: string, players: Array<{ seatNo: number; userId: string }>) {
    this.info("Hand started", {
      event: "hand_started",
      tableId,
      handId,
      playerCount: players.length,
      players: players.map((p) => ({ seatNo: p.seatNo, userId: p.userId })),
    });
  }

  handEnded(tableId: string, handId: string, winners: Array<{ seatNo: number; userId: string; payout: number }>) {
    this.info("Hand ended", {
      event: "hand_ended",
      tableId,
      handId,
      winners,
    });
  }

  playerAction(
    tableId: string,
    handId: string,
    userId: string,
    seatNo: number,
    action: string,
    amount?: number,
    timeout?: boolean
  ) {
    this.info("Player action", {
      event: "player_action",
      tableId,
      handId,
      userId,
      seatNo,
      action,
      amount,
      timeout: timeout ?? false,
    });
  }

  playerJoined(tableId: string, userId: string, seatNo?: number) {
    this.info("Player joined", {
      event: "player_joined",
      tableId,
      userId,
      seatNo,
    });
  }

  playerLeft(tableId: string, userId: string, cashout?: number) {
    this.info("Player left", {
      event: "player_left",
      tableId,
      userId,
      cashout,
    });
  }

  rateLimit(identifier: string, key: string) {
    this.warn("Rate limit exceeded", {
      event: "rate_limit",
      identifier,
      key,
    });
  }

  authFailure(ip: string, username?: string) {
    this.warn("Authentication failed", {
      event: "auth_failure",
      ip,
      username,
    });
  }
}

export const logger = new Logger();
