import jwt from "jsonwebtoken";

export type JwtUser = { userId: string; username: string };

export function signJwt(payload: JwtUser) {
    return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: "7d" });
}

export function verifyJwt(token: string): JwtUser {
    return jwt.verify(token, process.env.JWT_SECRET!) as JwtUser;
}
