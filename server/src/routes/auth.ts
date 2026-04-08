import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { signToken } from '../middleware/auth';

export const authRouter = Router();

// Generate hash: node -e "require('bcryptjs').hash('yourpassword',12).then(h=>console.log(h))"

authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  // Read env vars at request time (not module load time) to ensure dotenv has loaded
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || '';

  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }

  if (username !== ADMIN_USER) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (!ADMIN_PASS_HASH) {
    res.status(500).json({ error: 'Admin credentials not configured. Set ADMIN_PASS_HASH in .env' });
    return;
  }

  const valid = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = signToken({ username, role: 'admin' });
  res.json({ token, expiresIn: '8h' });
});
