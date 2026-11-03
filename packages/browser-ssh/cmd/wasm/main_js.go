//go:build js && wasm

package main

import (
	"errors"
	"io"
	"sync"
	"syscall/js"
	"time"

	"github.com/yceachan/pi-remote-vibe/browser-ssh/internal/sshbridge"
)

type entry struct {
	transport *socketConn
	ssh       *sshbridge.Connection
}

var (
	entries = map[string]*entry{}
	mutex   sync.Mutex
)

func promise(work func() (any, error)) any {
	fn := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer func() {
				if recover() != nil {
					reject.Invoke(js.Global().Get("Error").New("SSH WASM operation failed"))
				}
			}()
			result, err := work()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	})
	p := js.Global().Get("Promise").New(fn)
	fn.Release()
	return p
}

func get(id string) (*entry, error) {
	mutex.Lock()
	defer mutex.Unlock()
	e := entries[id]
	if e == nil || e.ssh == nil {
		return nil, errors.New("SSH connection is closed")
	}
	return e, nil
}

func closeEntry(id string) {
	mutex.Lock()
	e := entries[id]
	delete(entries, id)
	mutex.Unlock()
	if e != nil {
		e.transport.Close()
	}
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("open", js.FuncOf(func(_ js.Value, args []js.Value) any {
		options := args[0]
		id := options.Get("id").String()
		transport, err := newSocket(options.Get("url").String())
		if err != nil {
			return promise(func() (any, error) { return nil, err })
		}
		e := &entry{transport: transport}
		mutex.Lock()
		entries[id] = e
		mutex.Unlock()
		return promise(func() (_ any, err error) {
			defer func() {
				if err != nil {
					closeEntry(id)
				}
			}()
			transport.SetDeadline(time.Now().Add(20 * time.Second))
			if err = transport.open(); err != nil {
				return nil, err
			}
			key := []byte(options.Get("privateKey").String())
			defer clear(key)
			connection, err := sshbridge.Connect(transport, sshbridge.Options{
				Username: options.Get("username").String(), PrivateKey: key,
				ExpectedFingerprint: options.Get("expectedFingerprint").String(),
				HostKeyAlgorithm:    options.Get("hostKeyAlgorithm").String(),
				Command:             options.Get("command").String(),
			})
			if err != nil {
				return nil, err
			}
			mutex.Lock()
			e.ssh = connection
			mutex.Unlock()
			return id, nil
		})
	}))
	api.Set("read", js.FuncOf(func(_ js.Value, args []js.Value) any {
		id := args[0].String()
		return promise(func() (any, error) {
			e, err := get(id)
			if err != nil {
				return nil, err
			}
			buffer := make([]byte, 32<<10)
			n, err := e.ssh.Stdout.Read(buffer)
			if n > 0 {
				data := js.Global().Get("Uint8Array").New(n)
				js.CopyBytesToJS(data, buffer[:n])
				return data, nil
			}
			if err == io.EOF {
				err = e.ssh.Session.Wait()
				closeEntry(id)
				return nil, err
			}
			return nil, err
		})
	}))
	api.Set("write", js.FuncOf(func(_ js.Value, args []js.Value) any {
		id := args[0].String()
		data := make([]byte, args[1].Length())
		js.CopyBytesToGo(data, args[1])
		return promise(func() (any, error) {
			e, err := get(id)
			if err != nil {
				return nil, err
			}
			_, err = e.ssh.Stdin.Write(data)
			return nil, err
		})
	}))
	api.Set("eof", js.FuncOf(func(_ js.Value, args []js.Value) any {
		id := args[0].String()
		return promise(func() (any, error) {
			e, err := get(id)
			if err != nil {
				return nil, err
			}
			return nil, e.ssh.Stdin.Close()
		})
	}))
	api.Set("close", js.FuncOf(func(_ js.Value, args []js.Value) any { closeEntry(args[0].String()); return nil }))
	js.Global().Set("piRemoteSsh", api)
	select {}
}
