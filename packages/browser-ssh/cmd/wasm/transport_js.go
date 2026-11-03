//go:build js && wasm

package main

import (
	"errors"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

const maxQueuedBytes = 8 << 20

// socketConn presents the browser's binary WebSocket as a bounded byte stream.
// Event handlers never block the JS event loop. Overflow terminates the SSH
// connection, allowing the application to reconnect from its event cursor.
type socketConn struct {
	ws       js.Value
	incoming chan []byte
	closed   chan struct{}
	once     sync.Once
	mu       sync.Mutex
	err      error
	queued   int
	pending  []byte
	deadline *time.Timer
	handlers []js.Func
}

func newSocket(url string) (_ *socketConn, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = errors.New("could not create browser WebSocket")
		}
	}()
	ws := js.Global().Get("WebSocket").New(url)
	ws.Set("binaryType", "arraybuffer")
	c := &socketConn{ws: ws, incoming: make(chan []byte, 512), closed: make(chan struct{})}
	return c, nil
}

func (c *socketConn) open() error {
	select {
	case <-c.closed:
		return c.error()
	default:
	}
	ready := make(chan error, 1)
	finishOpen := func(err error) {
		select {
		case ready <- err:
		default:
		}
	}
	c.handlers = []js.Func{
		js.FuncOf(func(_ js.Value, _ []js.Value) any { finishOpen(nil); return nil }),
		js.FuncOf(func(_ js.Value, _ []js.Value) any {
			err := errors.New("SSH relay WebSocket failed")
			finishOpen(err)
			c.fail(err)
			return nil
		}),
		js.FuncOf(func(_ js.Value, _ []js.Value) any {
			finishOpen(io.EOF)
			c.fail(io.EOF)
			return nil
		}),
		js.FuncOf(func(_ js.Value, args []js.Value) any {
			data := args[0].Get("data")
			if !data.InstanceOf(js.Global().Get("ArrayBuffer")) {
				c.fail(errors.New("SSH relay sent a nonbinary frame"))
				return nil
			}
			size := data.Get("byteLength").Int()
			c.mu.Lock()
			if size > maxQueuedBytes-c.queued {
				c.mu.Unlock()
				c.fail(errors.New("SSH relay receive buffer exceeded"))
				return nil
			}
			c.queued += size
			c.mu.Unlock()
			chunk := make([]byte, size)
			js.CopyBytesToGo(chunk, js.Global().Get("Uint8Array").New(data))
			select {
			case c.incoming <- chunk:
			default:
				c.fail(errors.New("SSH relay receive queue exceeded"))
			}
			return nil
		}),
	}
	for i, name := range []string{"open", "error", "close", "message"} {
		c.ws.Call("addEventListener", name, c.handlers[i])
	}
	select {
	case err := <-ready:
		return err
	case <-c.closed:
		return c.error()
	}
}

func (c *socketConn) error() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	return io.ErrClosedPipe
}

func (c *socketConn) fail(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		c.err = err
		if c.deadline != nil {
			c.deadline.Stop()
		}
		c.mu.Unlock()
		close(c.closed)
		for i, name := range []string{"open", "error", "close", "message"} {
			if len(c.handlers) > i {
				c.ws.Call("removeEventListener", name, c.handlers[i])
				c.handlers[i].Release()
			}
		}
		c.handlers = nil
		c.ws.Call("close")
	})
}

func (c *socketConn) Close() error { c.fail(io.ErrClosedPipe); return nil }

func (c *socketConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(c.pending) == 0 {
		// A WebSocket close event can arrive immediately after its final data
		// event. Consume already queued SSH bytes before exposing EOF.
		select {
		case chunk := <-c.incoming:
			c.pending = chunk
			c.mu.Lock()
			c.queued -= len(chunk)
			c.mu.Unlock()
			continue
		default:
		}
		select {
		case chunk := <-c.incoming:
			c.pending = chunk
			c.mu.Lock()
			c.queued -= len(chunk)
			c.mu.Unlock()
		case <-c.closed:
			return 0, c.error()
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *socketConn) Write(p []byte) (written int, err error) {
	defer func() {
		if recover() != nil {
			err = errors.New("SSH relay WebSocket write failed")
			c.fail(err)
		}
	}()
	for len(p) > 0 {
		select {
		case <-c.closed:
			return written, c.error()
		default:
		}
		if c.ws.Get("readyState").Int() != 1 {
			return written, io.ErrClosedPipe
		}
		if c.ws.Get("bufferedAmount").Int() > 1<<20 {
			select {
			case <-time.After(10 * time.Millisecond):
				continue
			case <-c.closed:
				return written, c.error()
			}
		}
		n := min(len(p), 32<<10)
		array := js.Global().Get("Uint8Array").New(n)
		js.CopyBytesToJS(array, p[:n])
		c.ws.Call("send", array)
		p = p[n:]
		written += n
	}
	return written, nil
}

func (c *socketConn) LocalAddr() net.Addr  { return &net.TCPAddr{} }
func (c *socketConn) RemoteAddr() net.Addr { return &net.TCPAddr{} }
func (c *socketConn) SetDeadline(t time.Time) error {
	select {
	case <-c.closed:
		return c.error()
	default:
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deadline != nil {
		c.deadline.Stop()
		c.deadline = nil
	}
	if !t.IsZero() {
		c.deadline = time.AfterFunc(time.Until(t), func() { c.fail(errors.New("SSH connection timed out")) })
	}
	return nil
}
func (c *socketConn) SetReadDeadline(t time.Time) error  { return c.SetDeadline(t) }
func (c *socketConn) SetWriteDeadline(t time.Time) error { return c.SetDeadline(t) }
