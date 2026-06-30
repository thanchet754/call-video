'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { useState, useEffect } from 'react'

export default function PendingPage() {
  const router = useRouter()
  const supabase = createClient()
  const [checking, setChecking] = useState(false)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.refresh()
    router.push('/login')
  }

  const checkApproval = async () => {
    setChecking(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_approved')
        .eq('id', user.id)
        .single()
      
      if (profile?.is_approved) {
        router.refresh()
        router.push('/')
        return
      }
    }
    setChecking(false)
  }

  // Tự động kiểm tra trạng thái duyệt mỗi 5 giây
  useEffect(() => {
    const interval = setInterval(() => {
      checkApproval()
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="pending-wrapper">
      <div className="pending-card">
        <span className="pending-icon">⏳</span>
        <h2>Tài khoản đang chờ duyệt</h2>
        <p>
          Hệ thống nhắn tin nhóm nội bộ yêu cầu Admin phê duyệt tài khoản trước khi bạn có thể truy cập các cuộc hội thoại. 
          Vui lòng liên hệ trực tiếp với bạn Ngọc (Admin) để được duyệt tài khoản nhanh nhất.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button 
            onClick={checkApproval} 
            disabled={checking} 
            className="auth-btn" 
            style={{ margin: 0, padding: '10px 20px' }}
          >
            {checking ? 'Đang kiểm tra...' : 'Thử kiểm tra lại'}
          </button>
          <button 
            onClick={handleLogout} 
            className="pending-btn"
          >
            Đăng xuất
          </button>
        </div>
      </div>
    </div>
  )
}
