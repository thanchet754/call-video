'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'

interface Profile {
  id: string
  username: string
  full_name: string | null
  avatar_url: string | null
  status: string
  is_approved: boolean
  is_admin: boolean
  updated_at: string
}

export default function AdminPage() {
  const [users, setUsers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [audioEnabled, setAudioEnabled] = useState(false)
  const [notification, setNotification] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

  // Tạo âm thanh bíp thông báo bằng Web Audio API (tương thích tốt với Chrome & Safari)
  const playNotificationSound = () => {
    if (!audioEnabled) return
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new AudioContextClass()
      
      // Ding (tần số cao)
      const osc1 = ctx.createOscillator()
      const gain1 = ctx.createGain()
      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(987.77, ctx.currentTime) // B5
      gain1.gain.setValueAtTime(0.15, ctx.currentTime)
      gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4)
      osc1.connect(gain1)
      gain1.connect(ctx.destination)
      osc1.start()
      osc1.stop(ctx.currentTime + 0.4)

      // Dong (sau 150ms)
      setTimeout(() => {
        const osc2 = ctx.createOscillator()
        const gain2 = ctx.createGain()
        osc2.type = 'sine'
        osc2.frequency.setValueAtTime(783.99, ctx.currentTime) // G5
        gain2.gain.setValueAtTime(0.12, ctx.currentTime)
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)
        osc2.connect(gain2)
        gain2.connect(ctx.destination)
        osc2.start()
        osc2.stop(ctx.currentTime + 0.5)
      }, 150)

      // Rung thiết bị (chỉ chạy trên Chrome di động / Android)
      if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100])
      }
    } catch (e) {
      console.error(e)
    }
  }

  const fetchUsers = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('updated_at', { ascending: false })
      
      if (error) throw error
      if (data) setUsers(data as Profile[])
    } catch (e) {
      console.error('Lỗi khi lấy danh sách người dùng:', e)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  // Cập nhật trạng thái duyệt tài khoản
  const handleApproveToggle = async (userId: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_approved: !currentStatus })
        .eq('id', userId)
      
      if (error) throw error
      
      // Cập nhật local state nhanh
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, is_approved: !currentStatus } : u))
    } catch (e) {
      console.error('Lỗi khi cập nhật trạng thái duyệt:', e)
    }
  }

  // Cập nhật quyền Admin
  const handleAdminToggle = async (userId: string, currentAdminStatus: boolean) => {
    if (confirm(`Bạn có chắc chắn muốn ${currentAdminStatus ? 'hủy' : 'cấp'} quyền Admin cho tài khoản này?`)) {
      try {
        const { error } = await supabase
          .from('profiles')
          .update({ is_admin: !currentAdminStatus })
          .eq('id', userId)
        
        if (error) throw error
        
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, is_admin: !currentAdminStatus } : u))
      } catch (e) {
        console.error('Lỗi khi cập nhật quyền Admin:', e)
      }
    }
  }

  useEffect(() => {
    fetchUsers()

    // Lắng nghe realtime sự kiện đăng ký mới
    const channel = supabase
      .channel('admin-profiles-changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'profiles' },
        (payload) => {
          const newUser = payload.new as Profile
          setNotification(`Có thành viên mới đăng ký: ${newUser.full_name || newUser.username}`)
          playNotificationSound()
          fetchUsers()
          
          // Tự tắt thông báo sau 8 giây
          setTimeout(() => setNotification(null), 8000)
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        () => {
          fetchUsers()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchUsers, audioEnabled])

  const pendingCount = users.filter(u => !u.is_approved).length
  const approvedCount = users.filter(u => u.is_approved).length

  return (
    <div className="admin-container" onClick={() => setAudioEnabled(true)}>
      <div className="admin-header">
        <div>
          <h1>Hệ thống Quản trị (Admin)</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            {!audioEnabled 
              ? '👉 Click vào bất kỳ đâu trên màn hình này để KÍCH HOẠT âm thanh báo khi có người đăng ký mới!' 
              : '🔊 Đã kích hoạt âm thanh thông báo và bộ rung.'}
          </p>
        </div>
        <Link href="/" className="pending-btn" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          ← Quay lại Chat
        </Link>
      </div>

      {notification && (
        <div className="toast-container">
          <div className="toast warning" style={{ display: 'flex', justifyContent: 'space-between', width: '320px' }}>
            <span>🔔 {notification}</span>
            <button onClick={() => setNotification(null)} style={{ color: 'var(--text-muted)' }}>×</button>
          </div>
        </div>
      )}

      {/* Thống kê nhanh */}
      <div className="admin-stats-grid">
        <div className="stat-card">
          <div className="stat-icon">👥</div>
          <div>
            <div className="stat-num">{users.length}</div>
            <div className="stat-label">Tổng thành viên</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning)' }}>⏳</div>
          <div>
            <div className="stat-num">{pendingCount}</div>
            <div className="stat-label">Chờ phê duyệt</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: 'var(--success)' }}>✓</div>
          <div>
            <div className="stat-num">{approvedCount}</div>
            <div className="stat-label">Đã phê duyệt</div>
          </div>
        </div>
      </div>

      <h2 className="admin-section-title">Danh sách tài khoản đăng ký</h2>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Đang tải danh sách tài khoản...</p>
      ) : users.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>Chưa có tài khoản nào đăng ký.</p>
      ) : (
        <div className="user-table-card">
          <table className="user-table">
            <thead>
              <tr>
                <th>Thành viên</th>
                <th>Tên đăng nhập</th>
                <th>Trạng thái duyệt</th>
                <th>Quyền Admin</th>
                <th>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div className="avatar-wrapper" style={{ width: '36px', height: '36px' }}>
                        {user.avatar_url ? (
                          <img src={user.avatar_url} alt="avatar" className="avatar-img" />
                        ) : (
                          <div className="avatar-initial" style={{ fontSize: '13px' }}>
                            {(user.full_name || user.username)[0].toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{user.full_name || 'Không có tên'}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ID: {user.id.substring(0, 8)}...</div>
                      </div>
                    </div>
                  </td>
                  <td>@{user.username}</td>
                  <td>
                    <span className={`status-tag ${user.is_approved ? 'approved' : 'pending'}`}>
                      {user.is_approved ? 'Đã duyệt' : 'Chờ duyệt'}
                    </span>
                  </td>
                  <td>
                    <button 
                      onClick={() => handleAdminToggle(user.id, user.is_admin)}
                      style={{ 
                        color: user.is_admin ? 'var(--primary)' : 'var(--text-muted)',
                        fontWeight: user.is_admin ? 'bold' : 'normal'
                      }}
                    >
                      {user.is_admin ? '🛡️ Admin' : 'Thường'}
                    </button>
                  </td>
                  <td>
                    <div className="admin-actions">
                      <button 
                        onClick={() => handleApproveToggle(user.id, user.is_approved)}
                        className={`admin-btn ${user.is_approved ? 'reject' : 'approve'}`}
                      >
                        {user.is_approved ? 'Hủy duyệt' : 'Duyệt'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
