/* Minimal shims to allow `tsc` to emit `dist/` without installing @types packages.
   Runtime behavior is provided by Node.js and the installed JS dependencies. */

declare var process: any;
declare var require: any;
declare var console: any;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): any;
declare function clearTimeout(timeoutId: any): void;

declare namespace NodeJS {
  interface Timeout {}
}

declare module "express" {
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
  const exp: any;
  export default exp;
}

declare module "cors";
declare module "http";
declare module "bcrypt";
declare module "jsonwebtoken";
declare module "zod";
declare module "socket.io" {
  export type Server = any;
  export type Socket = any;
  export const Server: any;
  export const Socket: any;
}

declare module "ioredis";
declare module "@prisma/adapter-pg";


declare namespace express {
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
}
