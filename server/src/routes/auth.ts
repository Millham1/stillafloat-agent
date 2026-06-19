import { Router, type IRouter, type Request, type Response } from "express";
import { requireToken } from "../lib/http-auth";

const router: IRouter = Router();

// Lightweight endpoint the dashboard TokenGate calls to validate a token
// server-side before storing it. Returns 200 only when the token is valid
// (or when no token is configured, i.e. dev).
router.get("/auth-check", requireToken, (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export default router;
