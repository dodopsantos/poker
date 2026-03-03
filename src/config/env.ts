/**
 * Validates required environment variables at boot.
 * Fails fast with clear error messages if any are missing or invalid.
 */

import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection string"),
  
  // Redis
  REDIS_URL: z.string().url("REDIS_URL must be a valid Redis connection string"),
  
  // JWT
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters for security"),
  
  // Server
  PORT: z.string().regex(/^\d+$/, "PORT must be a number").transform(Number).optional(),
  CORS_ORIGIN: z.string().optional(),
  
  // Game config
  TURN_TIME_MS: z.string().regex(/^\d+$/).transform(Number).optional(),
  AWAY_TIMEOUTS_IN_ROW: z.string().regex(/^\d+$/).transform(Number).optional(),
  
  // Node env
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates environment variables and returns typed config.
 * Throws on validation failure with detailed error messages.
 */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("❌ Environment validation failed:");
    console.error("");
    
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      console.error(`  ${path}: ${issue.message}`);
    }
    
    console.error("");
    console.error("Please check your .env file and ensure all required variables are set.");
    process.exit(1);
  }

  return result.data;
}

/**
 * Logs validated config (safe: hides sensitive values).
 */
export function logEnvSummary(env: Env) {
  console.log("✅ Environment validated:");
  console.log(`  NODE_ENV: ${env.NODE_ENV ?? "development"}`);
  console.log(`  PORT: ${env.PORT ?? 3001}`);
  console.log(`  DATABASE_URL: ${maskConnectionString(env.DATABASE_URL)}`);
  console.log(`  REDIS_URL: ${maskConnectionString(env.REDIS_URL)}`);
  console.log(`  JWT_SECRET: ${env.JWT_SECRET ? "[SET]" : "[MISSING]"}`);
  console.log(`  CORS_ORIGIN: ${env.CORS_ORIGIN ?? "http://localhost:3000"}`);
  console.log(`  TURN_TIME_MS: ${env.TURN_TIME_MS ?? 15000}`);
  console.log(`  AWAY_TIMEOUTS_IN_ROW: ${env.AWAY_TIMEOUTS_IN_ROW ?? 2}`);
}

function maskConnectionString(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "[INVALID_URL]";
  }
}
