import { NextRequest, NextResponse } from 'next/server';
import { validManagementToken } from '@/lib/session-token';

const publicPaths = new Set(['/api/login', '/api/logout', '/api/current_user', '/api/health']);
const writes = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function middleware(request: NextRequest) {
  if (writes.has(request.method)) {
    const site = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
    const origin = request.headers.get('origin') ?? request.headers.get('referer');
    const host = (
      request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    )?.toLowerCase();
    let invalid = site === 'cross-site' || site === 'same-site';
    if (origin) {
      try {
        invalid ||= new URL(origin).host.toLowerCase() !== host;
      } catch {
        invalid = true;
      }
    }
    if (invalid)
      return NextResponse.json({ error: '跨站请求已被拦截，请刷新页面后重试' }, { status: 403 });
  }
  if (request.nextUrl.pathname.startsWith('/api/') && !publicPaths.has(request.nextUrl.pathname)) {
    const name =
      process.env.NODE_ENV === 'production' ? '__Host-lxl_admin_session' : 'lxl_admin_session';
    if (
      !(await validManagementToken(
        request.cookies.get(name)?.value,
        process.env.ADMIN_SESSION_SECRET,
      ))
    ) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }
    // Every protected handler performs database-backed administrator/role checks.
  }
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store, private');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export const config = { matcher: ['/api/:path*'] };
