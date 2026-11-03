package sshbridge

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/pem"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func newKey(t *testing.T) (ssh.Signer, []byte) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(key, "test")
	if err != nil {
		t.Fatal(err)
	}
	return signer, pem.EncodeToMemory(block)
}

type testServer struct {
	address   string
	hostKey   ssh.Signer
	clientKey []byte
	authCount atomic.Int32
	ptyCount  atomic.Int32
	command   chan string
}

func startServer(t *testing.T) *testServer {
	t.Helper()
	host, _ := newKey(t)
	client, key := newKey(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	s := &testServer{address: listener.Addr().String(), hostKey: host, clientKey: key, command: make(chan string, 1)}
	config := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		s.authCount.Add(1)
		if meta.User() != "test" || !bytes.Equal(key.Marshal(), client.PublicKey().Marshal()) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, nil
	}}
	config.AddHostKey(host)
	// Real OpenSSH hosts often offer multiple keys. Negotiation must select
	// the registered algorithm, rather than fail on an unrelated host key.
	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaSigner, err := ssh.NewSignerFromKey(ecdsaKey)
	if err != nil {
		t.Fatal(err)
	}
	config.AddHostKey(ecdsaSigner)
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer raw.Close()
				raw.SetDeadline(time.Now().Add(5 * time.Second))
				conn, channels, requests, err := ssh.NewServerConn(raw, config)
				if err != nil {
					return
				}
				defer conn.Close()
				go ssh.DiscardRequests(requests)
				for channel := range channels {
					stream, requests, err := channel.Accept()
					if err != nil {
						return
					}
					for request := range requests {
						switch request.Type {
						case "pty-req":
							s.ptyCount.Add(1)
							request.Reply(false, nil)
						case "exec":
							var payload struct{ Command string }
							if ssh.Unmarshal(request.Payload, &payload) != nil {
								request.Reply(false, nil)
								continue
							}
							s.command <- payload.Command
							request.Reply(true, nil)
							go func() {
								io.Copy(stream, stream)
								stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
								stream.Close()
							}()
						default:
							request.Reply(false, nil)
						}
					}
				}
			}()
		}
	}()
	return s
}

func (s *testServer) connect(t *testing.T, fingerprint string) (*Connection, error) {
	t.Helper()
	conn, err := net.Dial("tcp", s.address)
	if err != nil {
		t.Fatal(err)
	}
	return Connect(conn, Options{Username: "test", PrivateKey: s.clientKey, ExpectedFingerprint: fingerprint, Command: "pi-remote-attach", Timeout: 3 * time.Second})
}

func TestPrivateKeyExecBinaryDuplex(t *testing.T) {
	s := startServer(t)
	c, err := s.connect(t, ssh.FingerprintSHA256(s.hostKey.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	payload := bytes.Repeat([]byte{0, 1, 13, 10, 255, 128, 'x'}, 16_000)
	written := make(chan error, 1)
	go func() { _, err := c.Stdin.Write(payload); written <- err }()
	actual := make([]byte, len(payload))
	if _, err := io.ReadFull(c.Stdout, actual); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, actual) {
		t.Fatal("binary data changed")
	}
	if command := <-s.command; command != "pi-remote-attach" {
		t.Fatalf("unexpected exec %q", command)
	}
	if s.ptyCount.Load() != 0 {
		t.Fatal("a PTY was requested")
	}
	if s.authCount.Load() == 0 {
		t.Fatal("private key authentication was not used")
	}
	c.Stdin.Close()
	if _, err := io.Copy(io.Discard, c.Stdout); err != nil {
		t.Fatal(err)
	}
	if err := c.Session.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestHostMismatchRejectsBeforeAuthentication(t *testing.T) {
	s := startServer(t)
	wrong, _ := newKey(t)
	_, err := s.connect(t, ssh.FingerprintSHA256(wrong.PublicKey()))
	if err == nil || !strings.Contains(err.Error(), "host key mismatch") {
		t.Fatalf("expected mismatch, got %v", err)
	}
	if s.authCount.Load() != 0 {
		t.Fatal("authentication happened before host pin was accepted")
	}
}

func TestMissingPinAndWrongPrivateKeyFail(t *testing.T) {
	s := startServer(t)
	if _, err := s.connect(t, ""); err == nil {
		t.Fatal("missing pin accepted")
	}
	_, s.clientKey = newKey(t)
	if _, err := s.connect(t, ssh.FingerprintSHA256(s.hostKey.PublicKey())); err == nil {
		t.Fatal("wrong private key accepted")
	}
}

func TestHandshakeHasDeadline(t *testing.T) {
	local, remote := net.Pipe()
	defer remote.Close()
	_, key := newKey(t)
	_, err := Connect(local, Options{Username: "test", PrivateKey: key, ExpectedFingerprint: "SHA256:" + strings.Repeat("A", 43), Command: "attach", Timeout: 20 * time.Millisecond})
	if err == nil {
		t.Fatal("stalled handshake succeeded")
	}
}
