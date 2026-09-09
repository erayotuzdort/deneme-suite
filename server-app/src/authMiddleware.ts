import type { NextFunction, Request, Response } from "express";
import { verifyToken, DEFAULT_TOKENS_FILE } from "./auth";

declare global {
  namespace Express {
    interface Request {
      /** requireAuth başarıyla doğruladığında X-Device-Id'den atanır. */
      deviceId?: string;
    }
  }
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

// tokensFilePath parametreli fabrika: testlerin gerçek tokens.json'a
// dokunmadan, kendi geçici dosyalarına karşı izole middleware örnekleri
// kurabilmesi için (bkz. auth.ts'teki generateToken/verifyToken'ın aynı
// deseni). Üretimde kullanılan hazır `requireAuth`, varsayılan (env
// değişkenine duyarlı) dosyayı kullanır.
export function createRequireAuth(tokensFilePath: string = DEFAULT_TOKENS_FILE) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const deviceId = req.header("X-Device-Id");
    const authHeader = req.header("Authorization");
    const match = authHeader ? BEARER_PATTERN.exec(authHeader) : null;
    const token = match?.[1];

    // Hangi header'ın eksik/yanlış olduğu ayırt edilmiyor — bilgi
    // sızıntısına yol açmasın diye tek, jenerik mesaj.
    if (!deviceId || !token) {
      res.status(401).json({ ok: false, error: "Kimlik doğrulama gerekli" });
      return;
    }

    const valid = await verifyToken(deviceId, token, tokensFilePath);
    if (!valid) {
      res.status(401).json({ ok: false, error: "Kimlik doğrulama başarısız" });
      return;
    }

    req.deviceId = deviceId;
    next();
  };
}

export const requireAuth = createRequireAuth();
