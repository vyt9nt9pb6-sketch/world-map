// Vercel Function（Node.js runtime，Web 標準 Request/Response 寫法）
import { handleApiRequest } from '../core/handlers.js';
import { limiter } from './_limiter.js';

export async function GET(request) {
  return handleApiRequest(request, process.env, { rateLimiter: limiter });
}
