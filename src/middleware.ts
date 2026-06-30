import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'
import { createServerClient } from '@supabase/ssr'

export async function middleware(request: NextRequest) {
  // 1. Cập nhật và làm mới session
  let supabaseResponse = await updateSession(request)
  
  // 2. Tạo client lâm thời để kiểm tra quyền
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname

  // Bỏ qua các đường dẫn hệ thống và tệp tĩnh
  if (
    path.startsWith('/_next') ||
    path.startsWith('/api/') ||
    path.includes('.') ||
    path === '/favicon.ico'
  ) {
    return supabaseResponse
  }

  // 1. Nếu chưa đăng nhập: chỉ cho phép vào /login và /register
  if (!user) {
    if (path !== '/login' && path !== '/register') {
      return NextResponse.redirect(new URL('/login', request.url))
    }
    return supabaseResponse
  }

  // 2. Nếu đã đăng nhập: Lấy profile để kiểm tra phê duyệt & phân quyền
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_approved, is_admin')
    .eq('id', user.id)
    .single()

  const isApproved = profile?.is_approved || false
  const isAdmin = profile?.is_admin || false

  // 3. Xử lý điều hướng dựa trên trạng thái phê duyệt (is_approved)
  if (!isApproved) {
    // Chưa được duyệt: chỉ được ở trang /pending
    if (path !== '/pending') {
      return NextResponse.redirect(new URL('/pending', request.url))
    }
  } else {
    // Đã được duyệt: không được vào /login, /register, /pending nữa
    if (path === '/login' || path === '/register' || path === '/pending') {
      return NextResponse.redirect(new URL('/', request.url))
    }

    // Bảo vệ trang quản trị /admin
    if (path.startsWith('/admin') && !isAdmin) {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Khớp với tất cả các đường dẫn trừ các file tĩnh
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
