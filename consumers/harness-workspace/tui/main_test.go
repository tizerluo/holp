package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestViewModesRender(t *testing.T) {
	m := initialModel(demoFrame(), true)
	for _, key := range []string{"tab", "tab", "tab"} {
		next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)})
		m = next.(model)
	}
	out := m.View()
	if !strings.Contains(out, "Help") {
		t.Fatalf("expected help view, got %q", out)
	}
}

func TestKeyboardNavigationAndModeSwitching(t *testing.T) {
	f := demoFrame()
	f.Agents = append(f.Agents, agent{ID: "reviewer-1", Status: "ready", Role: "reviewer"})
	m := initialModel(f, true)

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(model)
	if m.mode != modeInspect || m.selectedAgentID() != "reviewer-1" {
		t.Fatalf("expected inspect reviewer-1, got mode=%s selected=%s", m.mode, m.selectedAgentID())
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(model)
	if m.mode != modeOverview {
		t.Fatalf("expected overview after esc, got %s", m.mode)
	}
}

func TestNoAnsiDeterministicOutput(t *testing.T) {
	first := initialModel(demoFrame(), true).View()
	second := initialModel(demoFrame(), true).View()
	if first != second {
		t.Fatal("expected deterministic output")
	}
	if strings.Contains(first, "\x1b[") {
		t.Fatalf("expected no ANSI output, got %q", first)
	}
	if !strings.Contains(first, "HOLP Harness Workspace") || !strings.Contains(first, "run_demo") {
		t.Fatalf("missing expected demo content: %q", first)
	}
}

func TestFrameMessageUpdatesModel(t *testing.T) {
	m := initialModel(frame{}, true)
	f := demoFrame()
	next, _ := m.Update(frameMsg(f))
	m = next.(model)
	if m.frame.RunID != "run_demo" {
		t.Fatalf("expected run_demo, got %s", m.frame.RunID)
	}
}

func TestIncomingFramePreservesStillValidLocalSelection(t *testing.T) {
	f := demoFrame()
	f.Agents = append(f.Agents, agent{ID: "reviewer-1", Status: "ready", Role: "reviewer"})
	m := initialModel(f, true)

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(model)
	if m.selectedAgentID() != "reviewer-1" {
		t.Fatalf("expected local reviewer selection, got %s", m.selectedAgentID())
	}

	incoming := f
	incoming.SelectedAgent = "fake-agent"
	incoming.RunID = "run_live_update"
	next, _ = m.Update(frameMsg(incoming))
	m = next.(model)
	if m.selectedAgentID() != "reviewer-1" {
		t.Fatalf("incoming frame wiped local selection: %s", m.selectedAgentID())
	}
	if m.frame.RunID != "run_live_update" {
		t.Fatalf("expected frame content to update, got %s", m.frame.RunID)
	}
}

func TestFollowKeySendsBrokerFollowCommand(t *testing.T) {
	socketPath := shortSocketPath(t)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	received := make(chan map[string]string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var command map[string]string
		if err := json.NewDecoder(conn).Decode(&command); err == nil {
			received <- command
		}
		_, _ = conn.Write([]byte(`{"type":"ack","command":"follow"}` + "\n"))
	}()

	f := demoFrame()
	f.Agents = append(f.Agents, agent{ID: "reviewer-1", Status: "ready", Role: "reviewer"})
	m := initialModel(f, true)
	m.socketPath = socketPath
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(model)
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'f'}})
	m = next.(model)
	if cmd == nil {
		t.Fatal("expected follow command")
	}
	if msg := cmd(); msg != nil {
		t.Fatalf("expected ack without message, got %#v", msg)
	}

	command := <-received
	if command["type"] != "follow" || command["agent"] != "reviewer-1" {
		t.Fatalf("unexpected follow command: %#v", command)
	}
}

func TestFollowCommandSkipsLargeInitialBrokerFrameBeforeAck(t *testing.T) {
	socketPath := shortSocketPath(t)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var command map[string]string
		_ = json.NewDecoder(conn).Decode(&command)
		large := demoFrame()
		large.Overview.WorkerPreview.RenderedText = strings.Repeat("x", 70*1024)
		writeFrame(t, conn, large)
		_, _ = conn.Write([]byte(`{"type":"ack","command":"follow"}` + "\n"))
	}()

	if msg := sendFollowCommandWithTimeout(socketPath, "fake-agent", time.Second)(); msg != nil {
		t.Fatalf("expected follow ack after large broker frame, got %#v", msg)
	}
}

func TestDecodeFramesSendsMultipleBrokerFrames(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()

	first := demoFrame()
	first.RunID = "run_first"
	second := demoFrame()
	second.RunID = "run_second"

	var messages []tea.Msg
	done := make(chan error, 1)
	go func() {
		done <- decodeFrames(left, func(msg tea.Msg) {
			messages = append(messages, msg)
		})
	}()

	writeFrame(t, right, first)
	writeFrame(t, right, second)
	right.Close()

	if err := <-done; err == nil || !strings.Contains(err.Error(), "broker stream closed") {
		t.Fatalf("expected broker stream closed error, got %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected two frame messages, got %d", len(messages))
	}

	m := initialModel(frame{}, true)
	for _, msg := range messages {
		next, _ := m.Update(msg)
		m = next.(model)
	}
	if m.frame.RunID != "run_second" {
		t.Fatalf("expected latest frame run_second, got %s", m.frame.RunID)
	}
}

func TestDecodeFramesAcceptsLargeBrokerFrame(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()

	large := demoFrame()
	large.RunID = "run_large"
	large.Overview.WorkerPreview.RenderedText = strings.Repeat("x", 70*1024)

	var messages []tea.Msg
	done := make(chan error, 1)
	go func() {
		done <- decodeFrames(left, func(msg tea.Msg) {
			messages = append(messages, msg)
		})
	}()

	writeFrame(t, right, large)
	right.Close()

	if err := <-done; err == nil || !strings.Contains(err.Error(), "broker stream closed") {
		t.Fatalf("expected broker stream closed error, got %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected one large frame message, got %d", len(messages))
	}
	m := initialModel(frame{}, true)
	next, _ := m.Update(messages[0])
	m = next.(model)
	if m.frame.RunID != "run_large" || len(m.frame.Overview.WorkerPreview.RenderedText) <= 64*1024 {
		t.Fatalf("large frame was not decoded correctly")
	}
}

func TestNarrowCJKNoAnsiRendering(t *testing.T) {
	f := demoFrame()
	f.Overview.Title = "证据面板"
	f.Overview.WorkerPreview.RenderedText = "证据abcdef"
	m := initialModel(f, true)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 24, Height: 6})
	m = next.(model)
	out := m.View()
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("expected no ANSI output, got %q", out)
	}
	if !strings.Contains(out, "证据") || !strings.Contains(out, "run_demo") {
		t.Fatalf("missing CJK or run content in narrow output: %q", out)
	}
	if got := len(strings.Split(out, "\n")); got < 3 {
		t.Fatalf("expected multi-line narrow rendering, got %d lines", got)
	}
}

func TestConnectionErrorSurfacesAsDegradedMessage(t *testing.T) {
	m := initialModel(frame{}, true)
	next, _ := m.Update(errMsg(net.ErrClosed))
	m = next.(model)
	out := m.View()
	if !strings.Contains(out, "degraded=") || !strings.Contains(out, "use of closed network connection") {
		t.Fatalf("expected degraded error in view, got %q", out)
	}
}

func TestFollowCommandSurfacesSocketError(t *testing.T) {
	socketPath := shortSocketPath(t)
	_ = os.Remove(socketPath)
	msg := sendFollowCommand(socketPath, "fake-agent")()
	if msg == nil {
		t.Fatal("expected socket error message")
	}
	m := initialModel(demoFrame(), true)
	next, _ := m.Update(msg)
	m = next.(model)
	if !strings.Contains(m.View(), "degraded=") {
		t.Fatalf("expected degraded view for follow error, got %q", m.View())
	}
}

func TestFollowCommandTimesOutWhenListenerNeverReplies(t *testing.T) {
	socketPath := shortSocketPath(t)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	done := make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			<-done
			_ = conn.Close()
		}
	}()
	defer close(done)

	msg := sendFollowCommandWithTimeout(socketPath, "fake-agent", 50*time.Millisecond)()
	if msg == nil {
		t.Fatal("expected timeout error message")
	}
	m := initialModel(demoFrame(), true)
	next, _ := m.Update(msg)
	m = next.(model)
	if !strings.Contains(m.View(), "degraded=") {
		t.Fatalf("expected degraded view for follow timeout, got %q", m.View())
	}
}

func writeFrame(t *testing.T, conn net.Conn, f frame) {
	t.Helper()
	payload, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		t.Fatal(err)
	}
}

func shortSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "holp-tui-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return filepath.Join(dir, "b.sock")
}
