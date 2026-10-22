import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  hashPassword,
  verifyPassword,
  recoveryCode,
  recoveryHash,
  equalHash,
} from "./passwords.ts";
import type { Store, Account } from "./store.ts";

const authCookie = "office_auth",
  legacyCookie = "office_session";
const lifetime = 7 * 24 * 60 * 60 * 1000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function cookieId(req: { headers: { cookie?: string } }, name: string) {
  const value = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(name + "="))
    ?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? hash(value) : null;
}
export function sessionAccount(
  store: Store,
  req: { headers: { cookie?: string } },
) {
  const id = cookieId(req, authCookie);
  return id ? store.authSession(id) : null;
}
const userName = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const passwordValid = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
const publicAccount = (user: Account) => ({
  id: user.id,
  username: user.username,
  createdAt: user.createdAt,
});
const dummyPassword = hashPassword(randomBytes(32).toString("hex"));

export function accountAuth(store: Store, secureCookies = false, limit = 30) {
  const router = Router();
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: secureCookies,
    path: "/api",
  };
  const attempts = new Map<string, { count: number; until: number }>();
  function limited(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
    const keys = [
      `ip:${req.ip}`,
      `name:${userName(req.body?.username).slice(0, 64)}`,
    ];
    for (const key of keys) {
      const value = attempts.get(key);
      if (
        value &&
        value.count >= (key.startsWith("ip:") ? limit * 10 : limit)
      ) {
        res.set("Retry-After", String(Math.ceil((value.until - now) / 1000)));
        res
          .status(429)
          .json({ error: "시도가 너무 많습니다. 15분 후 다시 시도해 주세요." });
        return;
      }
    }
    if (attempts.size >= 10000 && keys.some((key) => !attempts.has(key))) {
      res
        .status(429)
        .json({ error: "지금은 요청이 많습니다. 잠시 후 다시 시도해 주세요." });
      return;
    }
    keys.forEach((key) => {
      const entry = attempts.get(key) ?? {
        count: 0,
        until: now + 15 * 60 * 1000,
      };
      entry.count++;
      attempts.set(key, entry);
    });
    next();
  }
  function issue(req: Request, res: Response, user: Account) {
    const previous = cookieId(req, authCookie);
    if (previous) store.revokeSession(previous);
    const token = randomBytes(32).toString("hex");
    store.addAuthSession(hash(token), user.id, Date.now() + lifetime);
    res.cookie(authCookie, token, { ...cookieOptions, maxAge: lifetime });
  }
  function legacy(req: Request) {
    return cookieId(req, legacyCookie);
  }
  function current(req: Request) {
    return sessionAccount(store, req);
  }
  function requireAccount(req: Request, res: Response, next: NextFunction) {
    const user = current(req);
    if (!user) {
      res
        .status(401)
        .json({ error: "로그인이 필요합니다. 다시 로그인해 주세요." });
      return;
    }
    if (
      req.get("x-office-account") &&
      req.get("x-office-account") !== user.id
    ) {
      res
        .status(401)
        .json({
          error: "로그인 계정이 변경되었습니다. 화면을 다시 확인해 주세요.",
        });
      return;
    }
    res.locals.account = user;
    res.locals.owner = cookieId(req, authCookie);
    next();
  }
  router.get("/session", (req, res) => {
    const source = legacy(req),
      user = current(req);
    res.json({
      user: user ? publicAccount(user) : null,
      legacyCount: source ? store.legacyCount(source) : 0,
    });
  });
  router.post("/register", limited, async (req, res) => {
    const username = userName(req.body?.username),
      password = req.body?.password;
    if (!/^[a-z][a-z0-9_]{2,31}$/.test(username) || !passwordValid(password)) {
      res
        .status(400)
        .json({
          error:
            "아이디는 영문 소문자로 시작하는 영문·숫자·밑줄 3~32자, 비밀번호는 12~128자로 입력해 주세요.",
        });
      return;
    }
    const recovery = recoveryCode();
    const user = store.register(
      username,
      await hashPassword(password),
      recovery.hash,
    );
    if (!user) {
      res
        .status(409)
        .json({
          error: "사용할 수 없는 아이디입니다. 다른 아이디를 입력해 주세요.",
        });
      return;
    }
    issue(req, res, user);
    res.status(201).json({ user, recoveryCode: recovery.code });
  });
  router.post("/login", limited, async (req, res) => {
    const username = userName(req.body?.username),
      password = req.body?.password;
    if (!/^[a-z][a-z0-9_]{2,31}$/.test(username) || !passwordValid(password)) {
      res.status(401).json({ error: "아이디 또는 비밀번호를 확인해 주세요." });
      return;
    }
    const user = store.account(username);
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? (await dummyPassword),
    );
    if (
      !user ||
      !valid ||
      store.account(username)?.passwordHash !== user.passwordHash
    ) {
      res.status(401).json({ error: "아이디 또는 비밀번호를 확인해 주세요." });
      return;
    }
    issue(req, res, user);
    res.json({ user: publicAccount(user) });
  });
  router.post("/logout", (req, res) => {
    const id = cookieId(req, authCookie);
    if (id) store.revokeSession(id);
    res.clearCookie(authCookie, cookieOptions);
    res.json({ ok: true });
  });
  router.post("/recover", limited, async (req, res) => {
    const username = userName(req.body?.username),
      code = req.body?.recoveryCode,
      password = req.body?.password;
    if (
      !passwordValid(password) ||
      typeof code !== "string" ||
      code.length > 100 ||
      !/^[a-f0-9]{64}$/i.test(code.trim().replaceAll("-", ""))
    ) {
      res
        .status(400)
        .json({
          error: "아이디·복구 코드와 12~128자의 새 비밀번호를 확인해 주세요.",
        });
      return;
    }
    const user = store.account(username),
      supplied = recoveryHash(code);
    if (!user || !equalHash(user.recoveryHash, supplied)) {
      res.status(400).json({ error: "아이디 또는 복구 코드를 확인해 주세요." });
      return;
    }
    const next = recoveryCode();
    if (
      !store.resetPassword(
        username,
        supplied,
        await hashPassword(password),
        next.hash,
      )
    ) {
      res
        .status(400)
        .json({
          error: "이미 사용된 복구 코드입니다. 최신 코드를 확인해 주세요.",
        });
      return;
    }
    res.clearCookie(authCookie, cookieOptions);
    res.json({ recoveryCode: next.code });
  });
  router.post("/renew-recovery", requireAccount, limited, async (req, res) => {
    const user = store.account(res.locals.account.username),
      password = req.body?.password;
    if (
      !user ||
      !passwordValid(password) ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      res.status(401).json({ error: "현재 비밀번호를 확인해 주세요." });
      return;
    }
    const next = recoveryCode();
    if (!store.resetRecovery(user.id, user.passwordHash, next.hash)) {
      res
        .status(401)
        .json({ error: "인증 정보가 변경되었습니다. 다시 로그인해 주세요." });
      return;
    }
    res.json({ recoveryCode: next.code });
  });
  router.post("/import-legacy", requireAccount, (req, res) => {
    const source = legacy(req);
    const imported = source
      ? store.importLegacy(source, res.locals.account.id)
      : 0;
    res.json({ imported });
  });
  return { router, requireAccount };
}
