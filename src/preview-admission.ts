import type { Request, Response, NextFunction } from 'express';

// Argon2 retains its normal work factor. Preview rejects overlapping expensive auth
// operations rather than allowing multiple native-memory allocations in 512MB.
export function previewAuthAdmission() {
  let active = false;
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !/^\/api\/(auth|account|privacy)(\/|$)/.test(req.path)) return next();
    if (active) return res.status(429).json({ message: 'Preview account operation in progress. Please retry shortly.' });
    active = true;
    let released = false;
    const release = () => { if (!released) { released = true; active = false; } };
    res.once('finish', release); res.once('close', release);
    next();
  };
}
