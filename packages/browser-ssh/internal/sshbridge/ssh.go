// Package sshbridge opens a single, strictly pinned SSH exec channel.
package sshbridge

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type Options struct {
	Username            string
	PrivateKey          []byte
	ExpectedFingerprint string
	HostKeyAlgorithm    string
	Command             string
	Timeout             time.Duration
}

type Connection struct {
	Client  *ssh.Client
	Session *ssh.Session
	Stdin   io.WriteCloser
	Stdout  io.Reader
}

var fingerprintPattern = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)

// Connect takes ownership of transport, closing it on every error. The pinned
// fingerprint must come from a separately trusted registration process.
func Connect(transport net.Conn, options Options) (_ *Connection, err error) {
	defer func() {
		if err != nil {
			transport.Close()
		}
	}()
	if !fingerprintPattern.MatchString(options.ExpectedFingerprint) {
		return nil, errors.New("a registered SHA256 SSH host fingerprint is required")
	}
	if strings.TrimSpace(options.Username) == "" || options.Command == "" || strings.ContainsRune(options.Command, '\x00') {
		return nil, errors.New("SSH username and exec command are required")
	}
	signer, err := ssh.ParsePrivateKey(options.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("parse unlocked SSH private key: %w", err)
	}
	if options.Timeout <= 0 {
		options.Timeout = 20 * time.Second
	}
	if options.HostKeyAlgorithm == "" {
		options.HostKeyAlgorithm = ssh.KeyAlgoED25519
	}
	switch options.HostKeyAlgorithm {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSASHA512:
	default:
		return nil, errors.New("unsupported registered SSH host key algorithm")
	}
	if err := transport.SetDeadline(time.Now().Add(options.Timeout)); err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:              options.Username,
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyAlgorithms: []string{options.HostKeyAlgorithm},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			actual := ssh.FingerprintSHA256(key)
			if subtle.ConstantTimeCompare([]byte(actual), []byte(options.ExpectedFingerprint)) != 1 {
				return fmt.Errorf("SSH host key mismatch: expected %s, received %s", options.ExpectedFingerprint, actual)
			}
			return nil
		},
	}
	conn, channels, requests, err := ssh.NewClientConn(transport, "registered-host", config)
	if err != nil {
		return nil, fmt.Errorf("SSH handshake: %w", err)
	}
	client := ssh.NewClient(conn, channels, requests)
	defer func() {
		if err != nil {
			client.Close()
		}
	}()
	session, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("SSH session: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// Diagnostics must never be mixed into the JSONL protocol. Continuously
	// draining stderr also prevents the remote process from blocking on it.
	session.Stderr = io.Discard
	// Deliberately no RequestPty/Shell: this is an exact non-PTY exec request.
	if err := session.Start(options.Command); err != nil {
		return nil, fmt.Errorf("SSH exec: %w", err)
	}
	if err := transport.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	return &Connection{Client: client, Session: session, Stdin: stdin, Stdout: stdout}, nil
}

func (c *Connection) Close() error { return c.Client.Close() }
