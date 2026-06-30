import { NextRequest, NextResponse } from 'next/server'
import { AccessToken } from 'livekit-server-sdk'
import { createClient } from '@/utils/supabase/server'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const roomName = searchParams.get('room')
    const identity = searchParams.get('identity')
    const name = searchParams.get('name')

    if (!roomName || !identity) {
      return NextResponse.json(
        { error: 'Thiếu tham số room và identity' },
        { status: 400 }
      )
    }

    // 1. Xác thực người dùng bằng Supabase SSR Server Client (Bảo mật tuyệt đối)
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Chưa đăng nhập' }, { status: 401 })
    }

    // 2. Kiểm tra xem người dùng có phải là tài khoản đã duyệt (is_approved = true) không
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_approved')
      .eq('id', user.id)
      .single()

    if (!profile?.is_approved) {
      return NextResponse.json({ error: 'Tài khoản chưa được phê duyệt' }, { status: 403 })
    }

    const apiKey = process.env.LIVEKIT_API_KEY
    const apiSecret = process.env.LIVEKIT_API_SECRET

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'LiveKit API key hoặc secret chưa được thiết lập trên máy chủ' },
        { status: 500 }
      )
    }

    // 3. Khởi tạo và ký mã thông báo AccessToken của LiveKit
    const at = new AccessToken(apiKey, apiSecret, {
      identity: identity,
      name: name || identity,
    })

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    })

    const jwt = await at.toJwt()

    return NextResponse.json({ token: jwt })
  } catch (error: any) {
    console.error('Lỗi API Token LiveKit:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
