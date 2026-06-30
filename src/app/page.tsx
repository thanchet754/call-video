'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { 
  Phone, Video, Pin, Image as ImageIcon, Send, LogOut, 
  Search, Plus, Shield, MessageSquare, Mic, Square, Smile, CornerDownLeft, Trash2, X, FolderOpen 
} from 'lucide-react'
import CallModal from '@/components/CallModal'

interface Profile {
  id: string
  username: string
  full_name: string | null
  avatar_url: string | null
  status: string
}

interface Room {
  id: string
  name: string | null
  is_group: boolean
  created_at: string
  // Extra fields
  display_name?: string
  display_avatar?: string | null
  last_message?: string
  last_message_time?: string
  recipient_id?: string
}

interface Message {
  id: string
  room_id: string
  sender_id: string
  content: string | null
  file_url: string | null
  created_at: string
  parent_id: string | null
  is_pinned: boolean
  sender_name?: string
  sender_avatar?: string | null
  parent_content?: string | null
  pending?: boolean // Tin nhắn chờ gửi (Optimistic update)
}

interface Reaction {
  message_id: string
  user_id: string
  emoji: string
  profiles?: {
    full_name: string | null
    username: string
  }
}

export default function ChatPage() {
  const router = useRouter()
  const supabase = createClient()

  // User State
  const [currentUser, setCurrentUser] = useState<Profile | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  
  // Chat Rooms State
  const [rooms, setRooms] = useState<Room[]>([])
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [onlineUsers, setOnlineUsers] = useState<Record<string, boolean>>({})

  // UI State
  const [loadingRooms, setLoadingRooms] = useState(true)
  const [messageInput, setMessageInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [allProfiles, setAllProfiles] = useState<Profile[]>([])
  const [selectedUsersForGroup, setSelectedUsersForGroup] = useState<string[]>([])
  const [groupNameInput, setGroupNameInput] = useState('')
  
  // Sub-features state
  const [replyingMessage, setReplyingMessage] = useState<Message | null>(null)
  const [showPinnedSidebar, setShowPinnedSidebar] = useState(false)
  const [showGallerySidebar, setShowGallerySidebar] = useState(false)
  const [pinnedMessages, setPinnedMessages] = useState<Message[]>([])
  const [sharedMedia, setSharedMedia] = useState<string[]>([])
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({}) // userId -> fullName
  const [messageReactions, setMessageReactions] = useState<Record<string, Reaction[]>>({}) // msgId -> Reactions
  const [showEmojiPanelId, setShowEmojiPanelId] = useState<string | null>(null)
  
  // Voice Recording state
  const [isRecording, setIsRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  
  // Call State
  const [callState, setCallState] = useState<{
    callerId: string
    callerName: string
    roomId: string
    roomName: string
    isGroup: boolean
    isVideo: boolean
    status: 'idle' | 'calling' | 'ringing' | 'connected'
  }>({
    callerId: '',
    callerName: '',
    roomId: '',
    roomName: '',
    isGroup: false,
    isVideo: false,
    status: 'idle'
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const generalChannelRef = useRef<any>(null)
  const roomChannelRef = useRef<any>(null)
  const typingTimeoutRef = useRef<any>(null)

  // Sửa lỗi chiều cao 100vh trên iOS Safari
  useEffect(() => {
    const setHeight = () => {
      document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`)
    }
    setHeight()
    window.addEventListener('resize', setHeight)
    return () => window.removeEventListener('resize', setHeight)
  }, [])
  
  // Lấy thông tin user hiện tại
  useEffect(() => {
    const fetchUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()
        
      if (profile) {
        setCurrentUser(profile)
        setIsAdmin(profile.is_admin)
        // Cập nhật trạng thái online
        await supabase.from('profiles').update({ status: 'online' }).eq('id', user.id)
      }
    }
    fetchUser()
  }, [supabase, router])

  // Lắng nghe tín hiệu cuộc gọi đến (General Channel)
  useEffect(() => {
    if (!currentUser) return

    const channel = supabase.channel(`user-signals-${currentUser.id}`)
    generalChannelRef.current = channel

    channel
      .on('broadcast', { event: 'call-invite' }, ({ payload }) => {
        // Chỉ nhận cuộc gọi nếu đang rảnh
        if (callState.status === 'idle') {
          setCallState({
            callerId: payload.callerId,
            callerName: payload.callerName,
            roomId: payload.roomId,
            roomName: payload.callerName,
            isGroup: false,
            isVideo: payload.isVideo,
            status: 'ringing'
          })
        }
      })
      .subscribe()

    // Khởi tạo trạng thái online/offline bằng Presence
    const presenceChannel = supabase.channel('online-presence', {
      config: { presence: { key: currentUser.id } }
    })

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const state = presenceChannel.presenceState()
        const onlineMap: Record<string, boolean> = {}
        Object.keys(state).forEach((key) => {
          onlineMap[key] = true
        })
        setOnlineUsers(onlineMap)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({ online_at: new Date().toISOString() })
        }
      })

    return () => {
      supabase.removeChannel(channel)
      supabase.removeChannel(presenceChannel)
    }
  }, [currentUser, callState.status, supabase])

  // Cuộn xuống tin nhắn cuối cùng
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, typingUsers])

  // Lấy danh sách phòng chat
  const fetchRooms = useCallback(async () => {
    if (!currentUser) return
    setLoadingRooms(true)
    try {
      // 1. Lấy danh sách ID phòng mà user tham gia
      const { data: members, error: memError } = await supabase
        .from('room_members')
        .select('room_id')
        .eq('user_id', currentUser.id)

      if (memError) throw memError

      if (!members || members.length === 0) {
        setRooms([])
        setLoadingRooms(false)
        return
      }

      const roomIds = members.map(m => m.room_id)

      // 2. Lấy chi tiết các phòng chat
      const { data: roomsData, error: roomsError } = await supabase
        .from('rooms')
        .select('*')
        .in('id', roomIds)

      if (roomsError) throw roomsError

      // 3. Với mỗi phòng, điền thông tin người đối thoại (nếu là chat 1-1) và tin nhắn cuối
      const processedRooms: Room[] = await Promise.all(
        roomsData.map(async (room) => {
          let display_name = room.name || 'Phòng chat'
          let display_avatar = null
          let recipient_id = undefined

          if (!room.is_group) {
            // Chat 1-1: Tìm thành viên còn lại
            const { data: otherMember } = await supabase
              .from('room_members')
              .select('user_id')
              .eq('room_id', room.id)
              .neq('user_id', currentUser.id)
              .single()

            if (otherMember) {
              recipient_id = otherMember.user_id
              const { data: profile } = await supabase
                .from('profiles')
                .select('full_name, username, avatar_url')
                .eq('id', otherMember.user_id)
                .single()

              if (profile) {
                display_name = profile.full_name || `@${profile.username}`
                display_avatar = profile.avatar_url
              }
            }
          }

          // Lấy tin nhắn cuối cùng
          const { data: lastMsg } = await supabase
            .from('messages')
            .select('content, created_at')
            .eq('room_id', room.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single()

          return {
            ...room,
            display_name,
            display_avatar,
            recipient_id,
            last_message: lastMsg?.content || 'Chưa có tin nhắn',
            last_message_time: lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
          }
        })
      )

      setRooms(processedRooms)
    } catch (e) {
      console.error('Lỗi lấy danh sách phòng:', e)
    } finally {
      setLoadingRooms(false)
    }
  }, [currentUser, supabase])

  useEffect(() => {
    if (currentUser) {
      fetchRooms()
    }
  }, [currentUser, fetchRooms])

  // Lấy chi tiết tin nhắn, reactions và pinned của phòng chat active
  const fetchRoomDetails = useCallback(async (roomId: string) => {
    try {
      // 1. Lấy tin nhắn
      const { data: msgs, error } = await supabase
        .from('messages')
        .select(`
          *,
          profiles:sender_id(full_name, avatar_url)
        `)
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })

      if (error) throw error

      // 2. Chuyển đổi dữ liệu và lấy trích dẫn reply nếu có
      const formattedMsgs: Message[] = await Promise.all(
        (msgs || []).map(async (msg: any) => {
          let parent_content = null
          if (msg.parent_id) {
            const { data: parentMsg } = await supabase
              .from('messages')
              .select('content')
              .eq('id', msg.parent_id)
              .single()
            parent_content = parentMsg?.content || null
          }

          return {
            id: msg.id,
            room_id: msg.room_id,
            sender_id: msg.sender_id,
            content: msg.content,
            file_url: msg.file_url,
            created_at: msg.created_at,
            parent_id: msg.parent_id,
            is_pinned: msg.is_pinned,
            sender_name: msg.profiles?.full_name || 'Người dùng',
            sender_avatar: msg.profiles?.avatar_url || null,
            parent_content
          }
        })
      )

      setMessages(formattedMsgs)

      // Lọc danh sách ảnh chia sẻ cho gallery
      const mediaList = formattedMsgs
        .filter(m => m.file_url && !m.file_url.includes('.webm'))
        .map(m => m.file_url!)
      setSharedMedia(mediaList)

      // Lọc tin nhắn ghim
      setPinnedMessages(formattedMsgs.filter(m => m.is_pinned))

      // 3. Lấy reactions của phòng chat
      const msgIds = formattedMsgs.map(m => m.id)
      if (msgIds.length > 0) {
        const { data: reactData } = await supabase
          .from('message_reactions')
          .select(`
            *,
            profiles:user_id(full_name, username)
          `)
          .in('message_id', msgIds)

        const reactMap: Record<string, Reaction[]> = {}
        reactData?.forEach((r: any) => {
          if (!reactMap[r.message_id]) reactMap[r.message_id] = []
          reactMap[r.message_id].push({
            message_id: r.message_id,
            user_id: r.user_id,
            emoji: r.emoji,
            profiles: {
              full_name: r.profiles?.full_name,
              username: r.profiles?.username
            }
          })
        })
        setMessageReactions(reactMap)
      } else {
        setMessageReactions({})
      }

    } catch (e) {
      console.error('Lỗi lấy dữ liệu phòng chat:', e)
    }
  }, [supabase])

  // Lắng nghe realtime tin nhắn & reactions trong phòng chat active
  useEffect(() => {
    if (!activeRoom) {
      setMessages([])
      return
    }

    fetchRoomDetails(activeRoom.id)

    // Khởi tạo kênh realtime cho phòng
    const channel = supabase.channel(`room-chat-${activeRoom.id}`)
    roomChannelRef.current = channel

    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${activeRoom.id}`
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            // Có tin nhắn mới: Lấy thông tin sender và cập nhật state
            const newMsg = payload.new as Message
            const { data: senderProfile } = await supabase
              .from('profiles')
              .select('full_name, avatar_url')
              .eq('id', newMsg.sender_id)
              .single()

            let parent_content = null
            if (newMsg.parent_id) {
              const { data: parentMsg } = await supabase
                .from('messages')
                .select('content')
                .eq('id', newMsg.parent_id)
                .single()
              parent_content = parentMsg?.content || null
            }

            const formatted: Message = {
              ...newMsg,
              sender_name: senderProfile?.full_name || 'Người dùng',
              sender_avatar: senderProfile?.avatar_url || null,
              parent_content
            }

            setMessages(prev => {
              // Tránh trùng lặp tin nhắn đã hiển thị dạng Optimistic
              const exists = prev.some(m => m.id === newMsg.id)
              if (exists) {
                return prev.map(m => m.id === newMsg.id ? formatted : m)
              }
              return [...prev, formatted]
            })

            // Cập nhật lại gallery
            if (formatted.file_url && !formatted.file_url.includes('.webm')) {
              setSharedMedia(prev => [...prev, formatted.file_url!])
            }

            // Cập nhật tin ghim nếu có
            if (formatted.is_pinned) {
              setPinnedMessages(prev => [...prev, formatted])
            }

            // Cập nhật tin nhắn cuối ở sidebar
            setRooms(prev => prev.map(r => r.id === activeRoom.id ? {
              ...r,
              last_message: formatted.content || '[File đính kèm]',
              last_message_time: new Date(formatted.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            } : r))

          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Message
            setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
            
            // Cập nhật danh sách tin ghim
            setPinnedMessages(prev => {
              if (updated.is_pinned) {
                const exists = prev.some(m => m.id === updated.id)
                if (exists) return prev.map(m => m.id === updated.id ? { ...m, ...updated } : m)
                const orig = messages.find(m => m.id === updated.id)
                return [...prev, { ...orig, ...updated } as Message]
              } else {
                return prev.filter(m => m.id !== updated.id)
              }
            })
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_reactions'
        },
        () => {
          // Lấy lại danh sách reactions khi có thay đổi
          fetchRoomDetails(activeRoom.id)
        }
      )
      // Lắng nghe chỉ báo đang nhập (Typing Indicator) qua Broadcast
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        setTypingUsers(prev => {
          const next = { ...prev }
          if (payload.is_typing) {
            next[payload.user_id] = payload.user_name
          } else {
            delete next[payload.user_id]
          }
          return next
        })
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [activeRoom, fetchRoomDetails, messages, supabase])

  // Gửi tin nhắn văn bản
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!messageInput.trim() || !activeRoom || !currentUser) return

    const text = messageInput
    setMessageInput('')
    setReplyingMessage(null)

    // Tạo ID tạm thời cho Optimistic UI (hiển thị tin nhắn chờ gửi)
    const tempId = `temp-${Date.now()}`
    const tempMsg: Message = {
      id: tempId,
      room_id: activeRoom.id,
      sender_id: currentUser.id,
      content: text,
      file_url: null,
      created_at: new Date().toISOString(),
      parent_id: replyingMessage?.id || null,
      is_pinned: false,
      sender_name: currentUser.full_name || currentUser.username,
      sender_avatar: currentUser.avatar_url,
      parent_content: replyingMessage?.content || null,
      pending: true
    }

    setMessages(prev => [...prev, tempMsg])

    try {
      const { data, error } = await supabase.from('messages').insert({
        room_id: activeRoom.id,
        sender_id: currentUser.id,
        content: text,
        parent_id: replyingMessage?.id || null
      }).select().single()

      if (error) throw error

      // Thay thế tin nhắn tạm bằng tin nhắn thực tế từ Database
      setMessages(prev => prev.map(m => m.id === tempId ? {
        ...m,
        id: data.id,
        created_at: data.created_at,
        pending: false
      } : m))

    } catch (e) {
      console.error('Lỗi gửi tin nhắn:', e)
      // Đánh dấu đỏ/hoặc thông báo lỗi
      setMessages(prev => prev.filter(m => m.id !== tempId))
      alert('Không thể gửi tin nhắn. Vui lòng kiểm tra lại kết nối mạng!')
    }

    // Tắt trạng thái đang nhập
    sendTypingIndicator(false)
  }

  // Phát tín hiệu đang gõ chữ (typing indicator)
  const sendTypingIndicator = (isTyping: boolean) => {
    if (!roomChannelRef.current || !currentUser) return
    roomChannelRef.current.send({
      type: 'broadcast',
      event: 'typing',
      payload: {
        user_id: currentUser.id,
        user_name: currentUser.full_name || currentUser.username,
        is_typing: isTyping
      }
    })
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessageInput(e.target.value)

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)

    sendTypingIndicator(true)

    typingTimeoutRef.current = setTimeout(() => {
      sendTypingIndicator(false)
    }, 2000)
  }

  // Ghim / Bỏ ghim tin nhắn
  const togglePinMessage = async (msg: Message) => {
    try {
      const { error } = await supabase
        .from('messages')
        .update({ is_pinned: !msg.is_pinned })
        .eq('id', msg.id)

      if (error) throw error
    } catch (e) {
      console.error('Lỗi ghim tin nhắn:', e)
    }
  }

  // Thu hồi tin nhắn
  const handleUnsendMessage = async (msgId: string) => {
    if (confirm('Bạn có chắc chắn muốn thu hồi tin nhắn này?')) {
      try {
        const { error } = await supabase
          .from('messages')
          .update({ content: 'Tin nhắn đã bị thu hồi', file_url: null })
          .eq('id', msgId)

        if (error) throw error
      } catch (e) {
        console.error('Lỗi thu hồi tin nhắn:', e)
      }
    }
  }

  // Thả / Xóa cảm xúc emoji
  const handleToggleReaction = async (msgId: string, emoji: string) => {
    if (!currentUser) return
    setShowEmojiPanelId(null)

    const existingReact = messageReactions[msgId]?.find(
      r => r.user_id === currentUser.id && r.emoji === emoji
    )

    try {
      if (existingReact) {
        // Xóa cảm xúc cũ
        await supabase
          .from('message_reactions')
          .delete()
          .eq('message_id', msgId)
          .eq('user_id', currentUser.id)
          .eq('emoji', emoji)
      } else {
        // Thêm cảm xúc mới
        await supabase
          .from('message_reactions')
          .insert({ message_id: msgId, user_id: currentUser.id, emoji })
      }
    } catch (e) {
      console.error('Lỗi cập nhật cảm xúc:', e)
    }
  }

  // --- HÀNH ĐỘNG GỌI ĐIỆN VIDEO / THOẠI ---
  const startCall = (isVideo: boolean) => {
    if (!activeRoom || !currentUser) return

    // 1. Cuộc gọi Nhóm (LiveKit SFU)
    if (activeRoom.is_group) {
      setCallState({
        callerId: currentUser.id,
        callerName: currentUser.full_name || currentUser.username,
        roomId: activeRoom.id,
        roomName: activeRoom.display_name || 'Nhóm chat',
        isGroup: true,
        isVideo,
        status: 'connected'
      })
      return
    }

    // 2. Cuộc gọi 1-1 (P2P WebRTC): Gửi tín hiệu gọi đến cho đối phương qua kênh tín hiệu chung
    if (activeRoom.recipient_id && generalChannelRef.current) {
      // Gửi broadcast invite đến đối phương
      const inviteChannel = supabase.channel(`user-signals-${activeRoom.recipient_id}`)
      inviteChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          inviteChannel.send({
            type: 'broadcast',
            event: 'call-invite',
            payload: {
              callerId: currentUser.id,
              callerName: currentUser.full_name || currentUser.username,
              roomId: activeRoom.id,
              isVideo
            }
          })
          
          setCallState({
            callerId: currentUser.id,
            callerName: currentUser.full_name || currentUser.username,
            roomId: activeRoom.id,
            roomName: activeRoom.display_name || 'Đối phương',
            isGroup: false,
            isVideo,
            status: 'calling'
          })

          supabase.removeChannel(inviteChannel)
        }
      })
    }
  }

  // --- TẠO PHÒNG CHAT MỚI ---
  const openNewChatModal = async () => {
    setShowNewChatModal(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('is_approved', true)
        .neq('id', currentUser?.id)
      
      if (error) throw error
      setAllProfiles(data || [])
    } catch (e) {
      console.error('Lỗi lấy danh sách hồ sơ:', e)
    }
  }

  const handleStartConversation = async (recipientId: string) => {
    if (!currentUser) return
    
    // Kiểm tra xem đã có phòng chat 1-1 giữa 2 người này chưa
    try {
      const { data: myMemberships } = await supabase
        .from('room_members')
        .select('room_id')
        .eq('user_id', currentUser.id)

      const { data: recipientMemberships } = await supabase
        .from('room_members')
        .select('room_id')
        .eq('user_id', recipientId)

      const myRoomIds = myMemberships?.map(m => m.room_id) || []
      const recipientRoomIds = recipientMemberships?.map(m => m.room_id) || []

      // Tìm giao điểm của 2 mảng ID phòng
      const commonRoomIds = myRoomIds.filter(id => recipientRoomIds.includes(id))

      if (commonRoomIds.length > 0) {
        // Lấy phòng 1-1 có sẵn
        const { data: existingRoom } = await supabase
          .from('rooms')
          .select('*')
          .in('id', commonRoomIds)
          .eq('is_group', false)
          .limit(1)
          .single()

        if (existingRoom) {
          setShowNewChatModal(false)
          fetchRooms()
          // Chọn phòng chat active
          const matched = rooms.find(r => r.id === existingRoom.id)
          if (matched) setActiveRoom(matched)
          return
        }
      }

      // Tạo phòng chat mới nếu chưa có
      const { data: newRoom, error: roomError } = await supabase
        .from('rooms')
        .insert({ is_group: false })
        .select()
        .single()

      if (roomError) throw roomError

      // Thêm 2 thành viên vào phòng chat
      await supabase.from('room_members').insert([
        { room_id: newRoom.id, user_id: currentUser.id },
        { room_id: newRoom.id, user_id: recipientId }
      ])

      setShowNewChatModal(false)
      await fetchRooms()
      setActiveRoom({
        ...newRoom,
        display_name: 'Đang kết nối...',
        is_group: false
      })
    } catch (e) {
      console.error('Lỗi tạo hội thoại:', e)
    }
  }

  const handleCreateGroupChat = async () => {
    if (!currentUser || selectedUsersForGroup.length === 0) return
    const groupName = groupNameInput.trim() || 'Nhóm chat mới'
    
    try {
      const { data: newRoom, error: roomError } = await supabase
        .from('rooms')
        .insert({ is_group: true, name: groupName })
        .select()
        .single()

      if (roomError) throw roomError

      // Thêm tất cả thành viên (bao gồm bản thân)
      const membersToInsert = [
        { room_id: newRoom.id, user_id: currentUser.id },
        ...selectedUsersForGroup.map(userId => ({ room_id: newRoom.id, user_id: userId }))
      ]

      await supabase.from('room_members').insert(membersToInsert)

      setShowNewChatModal(false)
      setSelectedUsersForGroup([])
      setGroupNameInput('')
      await fetchRooms()
      setActiveRoom({
        ...newRoom,
        display_name: groupName,
        is_group: true
      })
    } catch (e) {
      console.error('Lỗi tạo nhóm chat:', e)
    }
  }

  const handleLogout = async () => {
    if (currentUser) {
      await supabase.from('profiles').update({ status: 'offline' }).eq('id', currentUser.id)
    }
    await supabase.auth.signOut()
    router.refresh()
    router.push('/login')
  }

  return (
    <div className="app-container">
      {/* SIDEBAR BÊN TRÁI - DANH SÁCH CHAT */}
      <div className={`sidebar ${!activeRoom ? 'active' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">Messenger</div>
          <div className="sidebar-actions">
            {isAdmin && (
              <Link href="/admin" className="icon-btn" title="Trang Admin">
                <Shield size={18} />
              </Link>
            )}
            <button onClick={openNewChatModal} className="icon-btn" title="Tạo chat mới">
              <Plus size={18} />
            </button>
          </div>
        </div>

        <div className="sidebar-search">
          <div className="search-input-wrapper">
            <Search className="search-icon" size={16} />
            <input 
              type="text" 
              placeholder="Tìm kiếm phòng chat..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="room-list">
          {loadingRooms ? (
            <p style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>Đang tải phòng chat...</p>
          ) : rooms.length === 0 ? (
            <div style={{ padding: '30px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <MessageSquare size={36} style={{ marginBottom: '8px', opacity: 0.5 }} />
              <p style={{ fontSize: '13px' }}>Chưa có hội thoại nào. Hãy bấm "+" để tạo mới!</p>
            </div>
          ) : (
            rooms
              .filter(r => r.display_name?.toLowerCase().includes(searchQuery.toLowerCase()))
              .map((room) => {
                const isOnline = !room.is_group && room.recipient_id && onlineUsers[room.recipient_id]
                return (
                  <div 
                    key={room.id} 
                    onClick={() => {
                      setActiveRoom(room)
                      setShowPinnedSidebar(false)
                      setShowGallerySidebar(false)
                    }}
                    className={`room-item ${activeRoom?.id === room.id ? 'active' : ''}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="avatar-wrapper">
                      {room.display_avatar ? (
                        <img src={room.display_avatar} alt="avatar" className="avatar-img" />
                      ) : (
                        <div className="avatar-initial">
                          {(room.display_name || 'U')[0].toUpperCase()}
                        </div>
                      )}
                      {isOnline && <span className="online-badge" />}
                    </div>
                    <div className="room-info">
                      <div className="room-name-wrapper">
                        <span className="room-name">{room.display_name}</span>
                        <span className="room-time">{room.last_message_time}</span>
                      </div>
                      <div className="room-last-msg">{room.last_message}</div>
                    </div>
                  </div>
                )
              })
          )}
        </div>

        {/* PROFILE BAR Ở ĐÁY SIDEBAR */}
        {currentUser && (
          <div className="sidebar-profile">
            <div className="profile-info">
              <div className="avatar-wrapper" style={{ width: '36px', height: '36px' }}>
                {currentUser.avatar_url ? (
                  <img src={currentUser.avatar_url} alt="avatar" className="avatar-img" />
                ) : (
                  <div className="avatar-initial" style={{ fontSize: '13px' }}>
                    {(currentUser.full_name || currentUser.username)[0].toUpperCase()}
                  </div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="profile-name">{currentUser.full_name || currentUser.username}</div>
                <div className="profile-role">{isAdmin ? '🛡️ Administrator' : 'Thành viên'}</div>
              </div>
            </div>
            <button onClick={handleLogout} className="icon-btn" title="Đăng xuất">
              <LogOut size={16} />
            </button>
          </div>
        )}
      </div>

      {/* KHUNG CHAT CHÍNH GIỮA */}
      <div className={`chat-area ${activeRoom ? 'active' : ''}`} style={{ display: !activeRoom ? 'none' : 'flex' }}>
        {activeRoom ? (
          <>
            {/* Header Chat */}
            <div className="chat-header">
              <div className="chat-active-info">
                <button onClick={() => setActiveRoom(null)} className="icon-btn" style={{ marginRight: '8px' }} id="back-to-sidebar-btn">
                  ←
                </button>
                <div className="avatar-wrapper" style={{ width: '40px', height: '40px' }}>
                  {activeRoom.display_avatar ? (
                    <img src={activeRoom.display_avatar} alt="avatar" className="avatar-img" />
                  ) : (
                    <div className="avatar-initial">
                      {(activeRoom.display_name || 'U')[0].toUpperCase()}
                    </div>
                  )}
                </div>
                <div>
                  <div className="chat-user-name">{activeRoom.display_name}</div>
                  <div className="chat-user-status">
                    {activeRoom.is_group 
                      ? 'Chat nhóm' 
                      : (activeRoom.recipient_id && onlineUsers[activeRoom.recipient_id] ? 'Đang hoạt động' : 'Ngoại tuyến')}
                  </div>
                </div>
              </div>

              <div className="chat-header-actions">
                <button onClick={() => startCall(false)} className="icon-btn" title="Gọi thoại">
                  <Phone size={18} />
                </button>
                <button onClick={() => startCall(true)} className="icon-btn" title="Gọi Video">
                  <Video size={18} />
                </button>
                <button 
                  onClick={() => {
                    setShowPinnedSidebar(!showPinnedSidebar)
                    setShowGallerySidebar(false)
                  }} 
                  className="icon-btn" 
                  title="Tin nhắn đã ghim"
                  style={{ color: showPinnedSidebar ? 'var(--warning)' : '' }}
                >
                  <Pin size={18} />
                </button>
                <button 
                  onClick={() => {
                    setShowGallerySidebar(!showGallerySidebar)
                    setShowPinnedSidebar(false)
                  }} 
                  className="icon-btn" 
                  title="Kho ảnh/file"
                  style={{ color: showGallerySidebar ? 'var(--primary)' : '' }}
                >
                  <FolderOpen size={18} />
                </button>
              </div>
            </div>

            {/* Vùng Tin nhắn */}
            <div className="messages-container">
              {messages.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  <MessageSquare size={48} style={{ opacity: 0.3, marginBottom: '12px' }} />
                  <p style={{ fontSize: '14px' }}>Chưa có tin nhắn nào. Gửi câu chào để bắt đầu cuộc hội thoại!</p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isSentByMe = msg.sender_id === currentUser?.id
                  const msgReactions = messageReactions[msg.id] || []
                  
                  return (
                    <div 
                      key={msg.id} 
                      className={`message-bubble-wrapper ${isSentByMe ? 'sent' : 'received'}`}
                    >
                      {/* Avatar người gửi (nếu là chat nhóm) */}
                      {!isSentByMe && activeRoom.is_group && (
                        <div className="avatar-wrapper" style={{ width: '32px', height: '32px', marginTop: '4px' }}>
                          {msg.sender_avatar ? (
                            <img src={msg.sender_avatar} alt="avatar" className="avatar-img" />
                          ) : (
                            <div className="avatar-initial" style={{ fontSize: '11px' }}>
                              {(msg.sender_name || 'U')[0].toUpperCase()}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="message-bubble-content">
                        {/* Tên người gửi (nếu là chat nhóm) */}
                        {!isSentByMe && activeRoom.is_group && (
                          <span className="message-sender-name">{msg.sender_name}</span>
                        )}

                        {/* Thẻ ghim tin nhắn */}
                        {msg.is_pinned && (
                          <div className="pinned-badge">
                            <Pin size={10} /> <span>Đã ghim</span>
                          </div>
                        )}

                        {/* Tin nhắn trả lời (Reply/Quote) */}
                        {msg.parent_content && (
                          <div className="reply-preview-in-msg">
                            ↪️ {msg.parent_content.substring(0, 40)}
                          </div>
                        )}

                        {/* Nội dung tin nhắn */}
                        <div 
                          className={`message-bubble ${msg.pending ? 'pending' : ''}`}
                          style={{ position: 'relative' }}
                          onDoubleClick={() => {
                            // Double click để hiển thị nhanh panel thả emoji
                            setShowEmojiPanelId(showEmojiPanelId === msg.id ? null : msg.id)
                          }}
                        >
                          {/* Tin nhắn văn bản */}
                          {msg.content && <div>{msg.content}</div>}

                          {/* Ảnh đính kèm */}
                          {msg.file_url && !msg.file_url.includes('.webm') && (
                            <img 
                              src={msg.file_url} 
                              alt="media" 
                              className="message-media" 
                              onClick={() => window.open(msg.file_url!, '_blank')} 
                            />
                          )}

                          {/* Tin nhắn thoại (.webm) */}
                          {msg.file_url && msg.file_url.includes('.webm') && (
                            <audio src={msg.file_url} controls className="message-audio" />
                          )}

                          {/* Bảng chọn thả cảm xúc (Emoji reactions menu) */}
                          {showEmojiPanelId === msg.id && (
                            <div style={{ 
                              position: 'absolute', 
                              bottom: isSentByMe ? '100%' : '100%', 
                              right: isSentByMe ? '0' : 'auto',
                              left: isSentByMe ? 'auto' : '0',
                              backgroundColor: 'var(--bg-card)', 
                              border: '1px solid var(--border-color)',
                              padding: '6px',
                              borderRadius: '20px',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                              display: 'flex',
                              gap: '6px',
                              zIndex: 60,
                              marginBottom: '6px'
                            }}>
                              {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                                <button 
                                  key={emoji} 
                                  onClick={() => handleToggleReaction(msg.id, emoji)}
                                  style={{ fontSize: '18px', padding: '2px 4px' }}
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Hiển thị các cảm xúc đã thả */}
                          {msgReactions.length > 0 && (
                            <div className="reactions-row">
                              {/* Gom nhóm các cảm xúc giống nhau */}
                              {Array.from(new Set(msgReactions.map(r => r.emoji))).map(emoji => {
                                const count = msgReactions.filter(r => r.emoji === emoji).length
                                const userReacted = msgReactions.some(r => r.user_id === currentUser?.id && r.emoji === emoji)
                                return (
                                  <button 
                                    key={emoji}
                                    onClick={() => handleToggleReaction(msg.id, emoji)}
                                    className={`reaction-badge ${userReacted ? 'user-reacted' : ''}`}
                                  >
                                    {emoji} {count > 1 ? count : ''}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>

                        {/* Meta tin nhắn: thời gian gửi, các thao tác */}
                        <div className="message-meta">
                          <span>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          
                          {/* Nút reply */}
                          <button 
                            onClick={() => setReplyingMessage(msg)} 
                            style={{ color: 'var(--text-muted)', fontSize: '11px', background: 'none' }}
                          >
                            Trả lời
                          </button>
                          
                          {/* Nút ghim */}
                          <button 
                            onClick={() => togglePinMessage(msg)} 
                            style={{ color: msg.is_pinned ? 'var(--warning)' : 'var(--text-muted)', fontSize: '11px', background: 'none' }}
                          >
                            {msg.is_pinned ? 'Bỏ ghim' : 'Ghim'}
                          </button>

                          {/* Nút thu hồi (chỉ cho phép nếu mình là người gửi hoặc mình là admin) */}
                          {(isSentByMe || isAdmin) && msg.content !== 'Tin nhắn đã bị thu hồi' && (
                            <button 
                              onClick={() => handleUnsendMessage(msg.id)} 
                              style={{ color: 'var(--danger)', fontSize: '11px', background: 'none' }}
                            >
                              <Trash2 size={11} style={{ display: 'inline', marginRight: '2px' }} /> Thu hồi
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}

              {/* Chỉ báo đối phương đang gõ chữ */}
              {Object.keys(typingUsers).length > 0 && (
                <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '8px' }}>
                  <span className="pending-icon" style={{ animation: 'float 1s infinite', fontSize: '14px' }}>✍️</span>
                  <span>{Object.values(typingUsers).join(', ')} đang gõ chữ...</span>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>

            {/* Vùng nhập Tin nhắn */}
            <div className="chat-input-wrapper">
              {/* Review Tin nhắn phản hồi (Reply Quote) */}
              {replyingMessage && (
                <div className="reply-bar-container">
                  <div>
                    <span style={{ fontWeight: 600, color: 'var(--primary)' }}>Đang trả lời: </span>
                    <span style={{ color: 'var(--text-muted)' }}>{replyingMessage.content?.substring(0, 60)}</span>
                  </div>
                  <button onClick={() => setReplyingMessage(null)} style={{ background: 'none' }}>
                    <X size={16} />
                  </button>
                </div>
              )}

              <form onSubmit={handleSendMessage} className="chat-input-row">
                {/* Upload Ảnh */}
                <div className="upload-btn-wrapper">
                  <label htmlFor="file-upload" className="icon-btn" style={{ cursor: 'pointer' }}>
                    <ImageIcon size={18} />
                  </label>
                  <input 
                    id="file-upload" 
                    type="file" 
                    accept="image/*" 
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        handleFileUpload(e.target.files[0])
                      }
                    }}
                    className="file-input" 
                  />
                </div>

                {/* Ghi âm tin nhắn thoại */}
                <button 
                  type="button"
                  onClick={isRecording ? stopRecording : startRecording}
                  className="icon-btn"
                  style={{ backgroundColor: isRecording ? 'var(--danger)' : '', color: isRecording ? 'white' : '' }}
                  title="Ghi âm giọng nói"
                >
                  {isRecording ? <Square size={16} /> : <Mic size={18} />}
                </button>

                {/* Khung Textarea */}
                <textarea
                  ref={chatInputRef}
                  value={messageInput}
                  onChange={handleInputChange}
                  placeholder={isRecording ? "🔴 Đang ghi âm giọng nói..." : "Nhập tin nhắn..."}
                  disabled={isRecording}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSendMessage(e)
                    }
                  }}
                  className="chat-input-row chat-textarea"
                />

                {/* Nút gửi */}
                <button type="submit" className="icon-btn" style={{ backgroundColor: 'var(--primary)', color: 'white' }}>
                  <Send size={18} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="chat-empty-state">
            <span className="chat-empty-logo">💬</span>
            <h3>Chào mừng bạn đến với Messenger Lite</h3>
            <p>Hãy chọn một cuộc hội thoại từ sidebar hoặc bắt đầu cuộc trò chuyện mới!</p>
          </div>
        )}
      </div>

      {/* SIDEBAR BÊN PHẢI - TIN NHẮN ĐÃ GHIM (PINNED MESSAGES) */}
      {showPinnedSidebar && activeRoom && (
        <div className="sidebar-right">
          <div className="sidebar-right-header">
            <span>📌 Tin nhắn đã ghim</span>
            <button onClick={() => setShowPinnedSidebar(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="sidebar-right-content">
            {pinnedMessages.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>Chưa ghim tin nhắn nào trong phòng này.</p>
            ) : (
              pinnedMessages.map(msg => (
                <div key={msg.id} className="pinned-item">
                  <div className="pinned-item-meta">
                    <span style={{ fontWeight: 600 }}>{msg.sender_name}</span>
                    <span>{new Date(msg.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="pinned-item-text">{msg.content}</div>
                  <button 
                    onClick={() => togglePinMessage(msg)}
                    style={{ position: 'absolute', top: '8px', right: '8px', color: 'var(--danger)', fontSize: '11px' }}
                  >
                    Bỏ ghim
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SIDEBAR BÊN PHẢI - KHO ẢNH CHIA SẺ (MEDIA GALLERY) */}
      {showGallerySidebar && activeRoom && (
        <div className="sidebar-right">
          <div className="sidebar-right-header">
            <span>🖼️ Hình ảnh chia sẻ</span>
            <button onClick={() => setShowGallerySidebar(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="sidebar-right-content">
            {sharedMedia.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>Chưa chia sẻ hình ảnh nào trong phòng này.</p>
            ) : (
              <div className="gallery-grid">
                {sharedMedia.map((url, index) => (
                  <img 
                    key={index} 
                    src={url} 
                    alt={`shared-${index}`} 
                    className="gallery-item"
                    onClick={() => window.open(url, '_blank')}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL TẠO CHAT MỚI / CHAT NHÓM */}
      {showNewChatModal && (
        <div className="call-modal-overlay">
          <div className="auth-card" style={{ maxWidth: '480px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700 }}>Bắt đầu cuộc trò chuyện mới</h2>
              <button onClick={() => setShowNewChatModal(false)} className="icon-btn">
                <X size={18} />
              </button>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>Tạo cuộc gọi / chat nhóm mới (Chọn nhiều người):</label>
              <input 
                type="text" 
                placeholder="Nhập tên nhóm chat..." 
                value={groupNameInput}
                onChange={(e) => setGroupNameInput(e.target.value)}
                style={{ width: '100%', marginBottom: '12px' }}
              />
              <button 
                onClick={handleCreateGroupChat} 
                disabled={selectedUsersForGroup.length === 0}
                className="auth-btn"
                style={{ margin: 0, padding: '10px 16px', width: '100%', borderRadius: '10px' }}
              >
                Tạo nhóm với {selectedUsersForGroup.length} người
              </button>
            </div>

            <hr style={{ borderColor: 'var(--border-color)', margin: '16px 0' }} />

            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Thành viên trực tuyến (Click để nhắn riêng 1-1):</div>
            <div style={{ maxHeight: '250px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {allProfiles.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Không có tài khoản nào trực tuyến để bắt đầu chat.</p>
              ) : (
                allProfiles.map(profile => {
                  const isChecked = selectedUsersForGroup.includes(profile.id)
                  return (
                    <div 
                      key={profile.id}
                      style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'space-between',
                        padding: '10px',
                        borderRadius: '10px',
                        border: '1px solid var(--border-color)',
                        backgroundColor: 'var(--bg-sidebar)'
                      }}
                    >
                      <div 
                        onClick={() => handleStartConversation(profile.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, cursor: 'pointer' }}
                      >
                        <div className="avatar-wrapper" style={{ width: '32px', height: '32px' }}>
                          {profile.avatar_url ? (
                            <img src={profile.avatar_url} alt="avatar" className="avatar-img" />
                          ) : (
                            <div className="avatar-initial" style={{ fontSize: '12px' }}>
                              {(profile.full_name || profile.username)[0].toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{profile.full_name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>@{profile.username}</div>
                        </div>
                      </div>

                      {/* Checkbox cho việc tạo chat nhóm */}
                      <input 
                        type="checkbox" 
                        checked={isChecked}
                        onChange={() => {
                          setSelectedUsersForGroup(prev => 
                            isChecked ? prev.filter(id => id !== profile.id) : [...prev, profile.id]
                          )
                        }}
                        style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                      />
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* OVERLAY CUỘC GỌI TRỰC TUYẾN (VOICE / VIDEO CALL) */}
      {callState.status !== 'idle' && currentUser && activeRoom && (
        <CallModal 
          roomId={callState.roomId}
          roomName={callState.roomName}
          isGroup={callState.isGroup}
          currentUser={{
            id: currentUser.id,
            full_name: currentUser.full_name,
            username: currentUser.username
          }}
          callData={callState}
          onClose={() => setCallState(prev => ({ ...prev, status: 'idle' }))}
        />
      )}
    </div>
  )
}
