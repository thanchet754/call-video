import { useEffect, useRef, useState } from 'react'
import { RealtimeChannel } from '@supabase/supabase-js'

interface WhiteboardProps {
  channel: RealtimeChannel
  onClose: () => void
}

export default function Whiteboard({ channel, onClose }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [color, setColor] = useState('#ff0000')
  const [lineWidth, setLineWidth] = useState(4)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    // Lắng nghe nét vẽ được đồng bộ từ thành viên khác
    const drawSubscription = channel.on('broadcast', { event: 'draw' }, ({ payload }) => {
      ctx.strokeStyle = payload.color
      ctx.lineWidth = payload.width
      ctx.beginPath()
      ctx.moveTo(payload.x1, payload.y1)
      ctx.lineTo(payload.x2, payload.y2)
      ctx.stroke()
    })

    const clearSubscription = channel.on('broadcast', { event: 'clear-whiteboard' }, () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    })

    return () => {
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [channel])

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    
    let clientX, clientY
    if ('touches' in e) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }

    const x = clientX - rect.left
    const y = clientY - rect.top
    lastPoint.current = { x, y }
    setIsDrawing(true)
  }

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !lastPoint.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rect = canvas.getBoundingClientRect()

    let clientX, clientY
    if ('touches' in e) {
      clientX = e.touches[0].clientX
      clientY = e.touches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }

    const x = clientX - rect.left
    const y = clientY - rect.top

    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y)
    ctx.lineTo(x, y)
    ctx.stroke()

    // Đồng bộ tọa độ nét vẽ qua Supabase Realtime Broadcast
    channel.send({
      type: 'broadcast',
      event: 'draw',
      payload: {
        x1: lastPoint.current.x,
        y1: lastPoint.current.y,
        x2: x,
        y2: y,
        color,
        width: lineWidth
      }
    })

    lastPoint.current = { x, y }
  }

  const stopDrawing = () => {
    setIsDrawing(false)
    lastPoint.current = null
  }

  const clearCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    
    channel.send({
      type: 'broadcast',
      event: 'clear-whiteboard',
      payload: {}
    })
  }

  return (
    <div className="whiteboard-overlay">
      <div className="whiteboard-header">
        <div style={{ fontWeight: 'bold' }}>Bảng vẽ thảo luận nhóm thời gian thực</div>
        <div className="whiteboard-tools">
          <input 
            type="color" 
            value={color} 
            onChange={(e) => setColor(e.target.value)} 
            style={{ width: '36px', height: '36px', padding: 0, border: 'none', cursor: 'pointer' }}
          />
          <select 
            value={lineWidth} 
            onChange={(e) => setLineWidth(Number(e.target.value))}
            style={{ padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-main)' }}
          >
            <option value={2}>Nét mảnh</option>
            <option value={4}>Nét vừa</option>
            <option value={8}>Nét dày</option>
            <option value={12}>Nét siêu dày</option>
          </select>
          <button onClick={clearCanvas} className="pending-btn" style={{ padding: '6px 12px', fontSize: '13px' }}>
            Xóa bảng
          </button>
          <button onClick={onClose} className="auth-btn" style={{ margin: 0, padding: '6px 12px', fontSize: '13px' }}>
            Đóng bảng
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={stopDrawing}
        className="whiteboard-canvas"
      />
    </div>
  )
}
