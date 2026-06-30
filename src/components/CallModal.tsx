import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import { LiveKitRoom, VideoConference } from '@livekit/components-react'
import { RealtimeChannel } from '@supabase/supabase-js'
import { X, Mic, MicOff, Video, VideoOff, PhoneOff, Monitor, RefreshCw, Edit3 } from 'lucide-react'
import Whiteboard from './Whiteboard'

// Import css của LiveKit để hiển thị đẹp nhất
import '@livekit/components-styles'

interface CallModalProps {
  roomId: string
  roomName: string
  isGroup: boolean
  currentUser: {
    id: string
    full_name: string | null
    username: string
  }
  callData: {
    callerId: string
    callerName: string
    isVideo: boolean
    status: 'idle' | 'calling' | 'ringing' | 'connected'
  }
  onClose: () => void
}

export default function CallModal({
  roomId,
  roomName,
  isGroup,
  currentUser,
  callData,
  onClose
}: CallModalProps) {
  const supabase = createClient()
  const [status, setStatus] = useState<'calling' | 'ringing' | 'connected' | 'ended'>(callData.status as any)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [micActive, setMicActive] = useState(true)
  const [videoActive, setVideoActive] = useState(callData.isVideo)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user')
  const [showWhiteboard, setShowWhiteboard] = useState(false)
  const [livekitToken, setLivekitToken] = useState<string | null>(null)
  const [callDuration, setCallDuration] = useState(0)

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const ringIntervalRef = useRef<any>(null)
  const timerIntervalRef = useRef<any>(null)

  // --- PHÁT ÂM THANH BẰNG WEB AUDIO API (KHÔNG CẦN TẢI FILE NHẠC) ---
  const startRingtone = useCallback((type: 'dial' | 'ring') => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new AudioContextClass()
      audioContextRef.current = ctx

      const playTone = () => {
        const osc1 = ctx.createOscillator()
        const osc2 = ctx.createOscillator()
        const gain = ctx.createGain()

        osc1.type = 'sine'
        osc2.type = 'sine'

        if (type === 'dial') {
          // Âm dial tone: Tần số kép 350Hz + 440Hz phát ngắt quãng
          osc1.frequency.setValueAtTime(350, ctx.currentTime)
          osc2.frequency.setValueAtTime(440, ctx.currentTime)
          gain.gain.setValueAtTime(0.08, ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2)
        } else {
          // Âm ring tone cuộc gọi đến: Tần số kép 440Hz + 480Hz
          osc1.frequency.setValueAtTime(440, ctx.currentTime)
          osc2.frequency.setValueAtTime(480, ctx.currentTime)
          gain.gain.setValueAtTime(0.12, ctx.currentTime)
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8)
        }

        osc1.connect(gain)
        osc2.connect(gain)
        gain.connect(ctx.destination)

        osc1.start()
        osc2.start()
        osc1.stop(ctx.currentTime + (type === 'dial' ? 1.2 : 1.8))
        osc2.stop(ctx.currentTime + (type === 'dial' ? 1.2 : 1.8))
      }

      playTone()
      ringIntervalRef.current = setInterval(playTone, type === 'dial' ? 3000 : 4000)
    } catch (e) {
      console.error('Không thể phát âm thanh chuông:', e)
    }
  }, [])

  const stopRingtone = useCallback(() => {
    if (ringIntervalRef.current) {
      clearInterval(ringIntervalRef.current)
      ringIntervalRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }, [])

  // --- CẤU HÌNH CAMERA / MICRO VÀ SAU ĐÓ KHỞI TẠO P2P WEBRTC ---
  const initLocalStream = async (overrideFacingMode?: 'user' | 'environment') => {
    try {
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop())
      }

      const mode = overrideFacingMode || facingMode
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: videoActive ? {
          facingMode: mode,
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 120 }
        } : false
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      setLocalStream(stream)
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }
      return stream
    } catch (err) {
      console.warn('Lỗi camera HD, thử hạ cấu hình hoặc dùng audio-only:', err)
      try {
        // Fallback sang cấu hình SD
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: videoActive ? { facingMode: overrideFacingMode || facingMode } : false
        })
        setLocalStream(stream)
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
        return stream
      } catch (e) {
        console.error('Không thể lấy quyền audio/video:', e)
        // Fallback sang audio-only
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        setLocalStream(stream)
        setVideoActive(false)
        return stream
      }
    }
  }

  // Khởi tạo RTC Peer Connection (1-1 call)
  const initPeerConnection = (stream: MediaStream) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    })

    // Add local tracks
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream)
    })

    // Lắng nghe stream từ đối phương
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0])
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0]
        }
      }
    }

    // Gửi ứng viên ICE candidate qua broadcast
    pc.onicecandidate = (event) => {
      if (event.candidate && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'call-candidate',
          payload: { candidate: event.candidate }
        })
      }
    }

    peerConnectionRef.current = pc
    return pc
  }

  // --- KÊNH TRUYỀN TÍN HIỆU (SIGNALING OVER SUPABASE BROADCAST) ---
  const setupSignaling = useCallback(async () => {
    const channel = supabase.channel(`call-signaling-${roomId}`)
    channelRef.current = channel

    channel
      .on('broadcast', { event: 'call-accept' }, async () => {
        // Người nhận chấp nhận -> Người gọi tạo SDP Offer
        stopRingtone()
        setStatus('connected')
        
        const stream = await initLocalStream()
        const pc = initPeerConnection(stream)
        
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        
        channel.send({
          type: 'broadcast',
          event: 'call-offer',
          payload: { sdp: offer }
        })
      })
      .on('broadcast', { event: 'call-offer', }, async ({ payload }) => {
        // Người nhận nhận được SDP Offer -> Thiết lập và tạo SDP Answer
        stopRingtone()
        setStatus('connected')
        
        const stream = await initLocalStream()
        const pc = initPeerConnection(stream)
        
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        
        channel.send({
          type: 'broadcast',
          event: 'call-answer',
          payload: { sdp: answer }
        })
      })
      .on('broadcast', { event: 'call-answer' }, async ({ payload }) => {
        // Người gọi nhận được SDP Answer -> Thiết lập remote description
        if (peerConnectionRef.current) {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp))
        }
      })
      .on('broadcast', { event: 'call-candidate' }, async ({ payload }) => {
        // Nhận ICE candidate của đối phương
        if (peerConnectionRef.current && payload.candidate) {
          try {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate))
          } catch (e) {
            console.error('Lỗi thêm ICE Candidate:', e)
          }
        }
      })
      .on('broadcast', { event: 'call-reject' }, () => {
        cleanupCall()
        setStatus('ended')
        setTimeout(onClose, 1500)
      })
      .on('broadcast', { event: 'call-end' }, () => {
        cleanupCall()
        setStatus('ended')
        setTimeout(onClose, 1500)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (callData.status === 'calling') {
            // Người gọi: Gửi broadcast mời gọi, phát dial tone
            channel.send({
              type: 'broadcast',
              event: 'call-invite',
              payload: {
                callerId: currentUser.id,
                callerName: currentUser.full_name || currentUser.username,
                isVideo: videoActive
              }
            })
            startRingtone('dial')
          } else if (callData.status === 'ringing') {
            // Người nhận: Phát chuông báo cuộc gọi đến
            startRingtone('ring')
          }
        }
      })
  }, [roomId, callData, currentUser, videoActive, startRingtone, stopRingtone, onClose, supabase])

  // --- HÀNH ĐỘNG CUỘC GỌI ---
  const acceptCall = async () => {
    stopRingtone()
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'call-accept',
        payload: {}
      })
    }
  }

  const rejectCall = () => {
    stopRingtone()
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'call-reject',
        payload: {}
      })
    }
    cleanupCall()
    onClose()
  }

  const endCall = () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'call-end',
        payload: {}
      })
    }
    cleanupCall()
    setStatus('ended')
    setTimeout(onClose, 1000)
  }

  // --- BẬT TẮT CAMERA / MIC VÀ CHIA SẺ MÀN HÌNH ---
  const toggleMic = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !micActive
        setMicActive(!micActive)
      }
    }
  }

  const toggleVideo = async () => {
    const nextVideoState = !videoActive
    setVideoActive(nextVideoState)

    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = nextVideoState
      } else if (nextVideoState) {
        // Nếu trước đó chưa lấy track video
        const newStream = await initLocalStream()
        if (peerConnectionRef.current && newStream) {
          const newVideoTrack = newStream.getVideoTracks()[0]
          const sender = peerConnectionRef.current.getSenders().find(s => s.track?.kind === 'video')
          if (sender && newVideoTrack) {
            sender.replaceTrack(newVideoTrack)
          }
        }
      }
    }
  }

  // Đổi camera trước/sau (Safari & Chrome mobile optimized)
  const toggleCamera = async () => {
    if (!videoActive) return
    const nextMode = facingMode === 'user' ? 'environment' : 'user'
    setFacingMode(nextMode)
    
    const stream = await initLocalStream(nextMode)
    if (peerConnectionRef.current && stream) {
      const newVideoTrack = stream.getVideoTracks()[0]
      const sender = peerConnectionRef.current.getSenders().find(s => s.track?.kind === 'video')
      if (sender && newVideoTrack) {
        await sender.replaceTrack(newVideoTrack)
      }
    }
  }

  // Chia sẻ màn hình (Web Screen Share)
  const toggleScreenShare = async () => {
    try {
      if (!isScreenSharing) {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
        const screenTrack = stream.getVideoTracks()[0]
        
        if (peerConnectionRef.current && screenTrack) {
          const sender = peerConnectionRef.current.getSenders().find(s => s.track?.kind === 'video')
          if (sender) {
            sender.replaceTrack(screenTrack)
          }
          
          // Lắng nghe khi người dùng bấm "Stop sharing" trên trình duyệt
          screenTrack.onended = () => {
            stopScreenSharing()
          }
        }
        
        setIsScreenSharing(true)
      } else {
        await stopScreenSharing()
      }
    } catch (err) {
      console.error('Không thể chia sẻ màn hình:', err)
    }
  }

  const stopScreenSharing = async () => {
    const stream = await initLocalStream()
    if (peerConnectionRef.current && stream) {
      const cameraTrack = stream.getVideoTracks()[0]
      const sender = peerConnectionRef.current.getSenders().find(s => s.track?.kind === 'video')
      if (sender && cameraTrack) {
        sender.replaceTrack(cameraTrack)
      }
    }
    setIsScreenSharing(false)
  }

  // --- DỌN DẸP KHI KẾT THÚC CUỘC GỌI (STRICT CLEANUP CHỐNG HAO PIN) ---
  const cleanupCall = useCallback(() => {
    stopRingtone()
    
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop())
      setLocalStream(null)
    }
    
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop())
      setRemoteStream(null)
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
  }, [localStream, remoteStream, stopRingtone, supabase])

  // --- KHỞI CHẠY LIVEKIT CHO CUỘC GỌI NHÓM (SFU) ---
  const fetchLivekitToken = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/livekit/token?room=${roomId}&identity=${currentUser.id}&name=${encodeURIComponent(currentUser.full_name || currentUser.username)}`
      )
      const data = await response.json()
      if (data.token) {
        setLivekitToken(data.token)
      } else {
        console.error('Lỗi tạo token LiveKit:', data.error)
      }
    } catch (e) {
      console.error('Không thể gọi API LiveKit Token:', e)
    }
  }, [roomId, currentUser])

  useEffect(() => {
    if (isGroup) {
      fetchLivekitToken()
    } else {
      setupSignaling()
    }

    return () => {
      cleanupCall()
    }
  }, [isGroup, setupSignaling, fetchLivekitToken, cleanupCall])

  // Chạy đếm giờ cuộc gọi
  useEffect(() => {
    if (status === 'connected') {
      timerIntervalRef.current = setInterval(() => {
        setCallDuration(prev => prev + 1)
      }, 1000)
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current)
      }
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current)
    }
  }, [status])

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60)
    const secs = sec % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // --- RENDER GIAO DIỆN LIVEKIT CHO CUỘC GỌI NHÓM ---
  if (isGroup && livekitToken) {
    return (
      <div className="call-modal-overlay">
        <div className="call-container" style={{ padding: 0 }}>
          <div className="call-header" style={{ padding: '0 24px', position: 'absolute', top: 0, left: 0, right: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)' }}>
            <div className="call-title">📞 Cuộc họp nhóm: {roomName}</div>
            <div className="call-timer" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button onClick={() => setShowWhiteboard(!showWhiteboard)} className="icon-btn" style={{ backgroundColor: 'rgba(255,255,255,0.2)', color: 'white' }}>
                <Edit3 size={18} />
              </button>
              <button onClick={onClose} className="icon-btn" style={{ backgroundColor: 'var(--danger)', color: 'white' }}>
                <X size={18} />
              </button>
            </div>
          </div>
          
          <LiveKitRoom
            video={videoActive}
            audio={micActive}
            token={livekitToken}
            serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL}
            onDisconnected={onClose}
            data-lk-theme="default"
            style={{ height: '100vh', width: '100vw' }}
          >
            <VideoConference />
          </LiveKitRoom>

          {showWhiteboard && channelRef.current && (
            <Whiteboard 
              channel={channelRef.current} 
              onClose={() => setShowWhiteboard(false)} 
            />
          )}
        </div>
      </div>
    )
  }

  // --- RENDER GIAO DIỆN CHỜ CUỘC GỌI / ĐANG ĐỔ CHUÔNG ---
  return (
    <div className="call-modal-overlay">
      <div className="call-container">
        {/* Header */}
        <div className="call-header">
          <div className="call-title">
            {videoActive ? <Video size={20} /> : <Mic size={20} />}
            <span>{roomName}</span>
          </div>
          {status === 'connected' && (
            <div className="call-timer">{formatDuration(callDuration)}</div>
          )}
        </div>

        {/* Trạng thái Đang gọi (Dialing) */}
        {status === 'calling' && (
          <div className="ringing-box">
            <div className="avatar-wrapper" style={{ width: '100px', height: '100px' }}>
              <div className="avatar-initial" style={{ fontSize: '36px' }}>{roomName[0]}</div>
            </div>
            <h3 style={{ fontSize: '20px' }}>Đang gọi cho {roomName}...</h3>
            <p style={{ color: '#94a3b8' }}>Vui lòng chờ đối phương nhấc máy</p>
            <div className="ringing-actions">
              <button onClick={endCall} className="ring-btn decline">
                <PhoneOff />
              </button>
            </div>
          </div>
        )}

        {/* Trạng thái Có cuộc gọi đến (Ringing) */}
        {status === 'ringing' && (
          <div className="ringing-box">
            <div className="avatar-wrapper" style={{ width: '100px', height: '100px' }}>
              <div className="avatar-initial" style={{ fontSize: '36px' }}>{roomName[0]}</div>
            </div>
            <h3 style={{ fontSize: '20px' }}>Cuộc gọi đến từ {callData.callerName}</h3>
            <p style={{ color: '#94a3b8' }}>Đang đổ chuông...</p>
            <div className="ringing-actions">
              <button onClick={acceptCall} className="ring-btn accept">
                <Video />
              </button>
              <button onClick={rejectCall} className="ring-btn decline">
                <PhoneOff />
              </button>
            </div>
          </div>
        )}

        {/* Trạng thái Cuộc gọi đã kết thúc */}
        {status === 'ended' && (
          <div className="ringing-box">
            <h3>Cuộc gọi đã kết thúc</h3>
            <p style={{ color: '#94a3b8' }}>Đang đóng kết nối...</p>
          </div>
        )}

        {/* Trạng thái Đã kết nối (Connected - Chat 1-1 WebRTC) */}
        {status === 'connected' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', width: '100%', height: '100%' }}>
            
            {/* Khung chứa Video */}
            <div className="video-grid-container grid-1">
              
              {/* Remote Video (Đối phương) */}
              <div className="video-cell">
                {remoteStream && videoActive ? (
                  <video 
                    ref={remoteVideoRef} 
                    autoPlay 
                    playsInline 
                    className="video-element back-camera" 
                  />
                ) : (
                  <div className="avatar-wrapper" style={{ width: '100px', height: '100px' }}>
                    <div className="avatar-initial" style={{ fontSize: '36px' }}>{roomName[0]}</div>
                  </div>
                )}
                <div className="participant-label">{roomName}</div>
              </div>

              {/* Local Video (Bản thân - cửa sổ nổi góc màn hình) */}
              {videoActive && (
                <div className="local-preview-floating">
                  <video 
                    ref={localVideoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    className={`video-element ${facingMode === 'environment' ? 'back-camera' : ''}`} 
                  />
                  <div className="participant-label" style={{ bottom: '4px', left: '4px', fontSize: '10px' }}>Bạn</div>
                </div>
              )}
            </div>

            {/* Bảng vẽ Whiteboard */}
            {showWhiteboard && channelRef.current && (
              <Whiteboard 
                channel={channelRef.current} 
                onClose={() => setShowWhiteboard(false)} 
              />
            )}

            {/* Thanh điều khiển Controls */}
            <div className="call-controls">
              <button 
                onClick={toggleMic} 
                className={`control-btn ${!micActive ? 'active' : ''}`}
                style={{ backgroundColor: !micActive ? 'var(--danger)' : '' }}
              >
                {micActive ? <Mic /> : <MicOff />}
              </button>
              
              <button 
                onClick={toggleVideo} 
                className={`control-btn ${!videoActive ? 'active' : ''}`}
                style={{ backgroundColor: !videoActive ? 'var(--danger)' : '' }}
              >
                {videoActive ? <Video /> : <VideoOff />}
              </button>

              {videoActive && (
                <button onClick={toggleCamera} className="control-btn">
                  <RefreshCw />
                </button>
              )}

              <button 
                onClick={toggleScreenShare} 
                className={`control-btn ${isScreenSharing ? 'active' : ''}`}
              >
                <Monitor />
              </button>

              <button onClick={() => setShowWhiteboard(!showWhiteboard)} className={`control-btn ${showWhiteboard ? 'active' : ''}`}>
                <Edit3 />
              </button>

              <button onClick={endCall} className="control-btn end-call">
                <PhoneOff />
              </button>
            </div>

          </div>
        )}
      </div>
    </div>
  )
}
