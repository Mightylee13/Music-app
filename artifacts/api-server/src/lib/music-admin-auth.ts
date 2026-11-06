import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";

const ADMIN_COOKIE_NAME = "lenzo_music_admin";
const ADMIN_COOKIE_PATH = "/api/music/admin";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 5;
const loginAttempts = new Map<string, number[]>();

function configuredPassword(): string | null {
  const password = process.env.LENZO_MUSIC_ADMIN_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!password || !sessionSecret) return null;
  return password;
}

export function isMusicAdminConfigured(): boolean {
  return configuredPassword() !== null;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyMusicAdminPassword(candidate: string): boolean {
  const expected = configuredPassword();
  return expected !== null && constantTimeStringEqual(candidate, expected);
}

function sessionSignature(encodedPayload: string): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function cookieToken(request: Request): string | null {
  const cookieHeader = request.header("cookie");
  if (!cookieHeader) return null;
  const pair = cookieHeader.split(";").map((part) => part.trim()).find((part) =>
    part.startsWith(`${ADMIN_COOKIE_NAME}=`),
  );
  return pair?.slice(ADMIN_COOKIE_NAME.length + 1) ?? null;
}

export function isMusicAdminAuthenticated(request: Request): boolean {
  if (!isMusicAdminConfigured()) return false;
  const token = cookieToken(request);
  if (!token) return false;
  const [encodedPayload, signature, extra] = token.split(".");
  if (
    extra !== undefined
    || !encodedPayload
    || !signature
    || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/.test(signature)
  ) {
    return false;
  }
  const expectedSignature = sessionSignature(encodedPayload);
  if (!expectedSignature) return false;
  const expected = Buffer.from(expectedSignature, "base64url");
  const supplied = Buffer.from(signature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;

  try {
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const [expiresAtText, nonce, extraPayload] = payload.split(".");
    const expiresAt = Number(expiresAtText);
    return extraPayload === undefined
      && Number.isSafeInteger(expiresAt)
      && expiresAt > Date.now()
      && !!nonce
      && /^[A-Za-z0-9_-]{16,}$/.test(nonce);
  } catch {
    return false;
  }
}

function isSecureRequest(request: Request): boolean {
  return process.env.NODE_ENV === "production"
    || request.secure
    || request.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function startMusicAdminSession(response: Response, request: Request): void {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const nonce = randomBytes(24).toString("base64url");
  const encodedPayload = Buffer.from(`${expiresAt}.${nonce}`).toString("base64url");
  const signature = sessionSignature(encodedPayload);
  if (!signature) throw new Error("Admin session signing is not configured.");
  response.cookie(ADMIN_COOKIE_NAME, `${encodedPayload}.${signature}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: ADMIN_COOKIE_PATH,
    maxAge: ADMIN_SESSION_TTL_MS,
  });
}

export function endMusicAdminSession(response: Response, request: Request): void {
  response.clearCookie(ADMIN_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: ADMIN_COOKIE_PATH,
  });
}

export function isSameOriginMusicAdminRequest(request: Request): boolean {
  const origin = request.header("origin");
  if (!origin) return true;
  const requestHost = request.header("x-forwarded-host")?.split(",")[0]?.trim()
    || request.header("host");
  if (!requestHost) return false;
  try {
    return new URL(origin).host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

export function consumeMusicAdminLoginAttempt(key: string): number {
  const now = Date.now();
  const recent = (loginAttempts.get(key) ?? []).filter((attempt) => now - attempt < LOGIN_WINDOW_MS);
  if (recent.length >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts.set(key, recent);
    return Math.max(1, LOGIN_WINDOW_MS - (now - recent[0]!));
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  if (loginAttempts.size > 1_000) {
    for (const [attemptKey, attempts] of loginAttempts) {
      if (attempts.every((attempt) => now - attempt >= LOGIN_WINDOW_MS)) loginAttempts.delete(attemptKey);
    }
  }
  return 0;
}

export function clearMusicAdminLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}
