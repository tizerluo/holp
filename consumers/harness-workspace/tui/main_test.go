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
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
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
	f.SelectedAgent = "fake-agent"
	f.Agents = []agent{
		{ID: "fake-agent", Status: "ready", Role: "coder", RoleSkin: "CODE"},
		{ID: "reviewer-1", Status: "ready", Role: "reviewer", RoleSkin: "REV"},
	}
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

func TestIssue95OverviewSidecarPanels(t *testing.T) {
	out := renderDemo(true, "overview", "", 100, 28)
	for _, want := range []string{"Chain Map", "Active Worker Preview", "Evidence Summary", "run_id", "selected", "schema_version", "worker_session", "direct_user_session", "attach_command", "terminal_state", "overview", "No blocking failure recorded"} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected overview demo to contain %q:\n%s", want, out)
		}
	}
	failureAt := strings.Index(out, "No blocking failure recorded")
	if failureAt < 0 || !strings.Contains(out[failureAt:], "+--------------------------------------------------------------------------------------------------+") {
		t.Fatalf("expected complete overview failure panel closure:\n%s", out)
	}
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("expected no ANSI overview output, got %q", out)
	}
}

func TestIssue95InspectSidecarPanels(t *testing.T) {
	out := renderDemo(true, "inspect", "coder-1", 100, 28)
	for _, want := range []string{"Selected Agent Detail", "Selected Evidence", "Output", "Operator actions", "Chain Map", "selected=coder-1", "direct_user_session", "run_id", "worker_session", "attach_command", "inspect"} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected inspect demo to contain %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("expected no ANSI inspect output, got %q", out)
	}
}

func TestIssue95DemoFlagsDriveOutput(t *testing.T) {
	overview := renderDemo(true, "overview", "", 72, 18)
	inspect := renderDemo(true, "inspect", "tester-1", 72, 18)
	if !strings.Contains(overview, "mode=overview") || strings.Contains(overview, "selected=tester-1") {
		t.Fatalf("overview demo flags did not drive mode cleanly:\n%s", overview)
	}
	if !strings.Contains(inspect, "mode=inspect") || !strings.Contains(inspect, "selected=tester-1") {
		t.Fatalf("inspect demo flags did not drive mode/agent:\n%s", inspect)
	}
	if lipgloss.Width(strings.Split(inspect, "\n")[1]) > 72 {
		t.Fatalf("expected width-constrained inspect render:\n%s", inspect)
	}
}

func TestIssue95SmallDemoKeepsRequiredAnchorsVisible(t *testing.T) {
	overview := renderDemo(true, "overview", "", 72, 18)
	for _, want := range []string{"schema_version", "worker_session", "direct_user_session", "attach_command", "terminal_state"} {
		if !strings.Contains(overview, want) {
			t.Fatalf("expected compact overview to contain %q:\n%s", want, overview)
		}
	}

	inspect := renderDemo(true, "inspect", "coder-1", 72, 18)
	for _, want := range []string{"Operator actions", "Output"} {
		if !strings.Contains(inspect, want) {
			t.Fatalf("expected compact inspect to contain %q:\n%s", want, inspect)
		}
	}
}

func TestIssue95StatusHonorsDemoWidth(t *testing.T) {
	out := renderDemo(true, "overview", "", 72, 18)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	tail := lines
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	joined := strings.Join(tail, "\n")
	for _, line := range tail {
		if lipgloss.Width(line) > 72 {
			t.Fatalf("expected each status line width <= 72, got %d: %q", lipgloss.Width(line), line)
		}
	}
	if strings.HasSuffix(strings.TrimSpace(tail[len(tail)-1]), "...") {
		t.Fatalf("expected status to wrap not truncate: %q", tail[len(tail)-1])
	}
	for _, want := range []string{"run_id", "selected", "mode", "q quit"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected status block to preserve %q: %q", want, joined)
		}
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
	f.SelectedAgent = "fake-agent"
	f.Agents = []agent{
		{ID: "fake-agent", Status: "ready", Role: "coder", RoleSkin: "CODE"},
		{ID: "reviewer-1", Status: "ready", Role: "reviewer", RoleSkin: "REV"},
	}
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
	f.SelectedAgent = "fake-agent"
	f.Agents = []agent{
		{ID: "fake-agent", Status: "ready", Role: "coder", RoleSkin: "CODE"},
		{ID: "reviewer-1", Status: "ready", Role: "reviewer", RoleSkin: "REV"},
	}
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

func TestChineseChromeKeepsDiagnosticAnchorsLiteral(t *testing.T) {
	f := demoFrame()
	f.Locale = "zh-CN"
	m := initialModel(f, true)

	overview := m.View()
	for _, anchor := range []string{"run_id", "selected", "overview", "schema_version"} {
		if !strings.Contains(overview, anchor) {
			t.Fatalf("expected overview to keep literal diagnostic anchor %q:\n%s", anchor, overview)
		}
	}
	if !strings.Contains(overview, "总览") || !strings.Contains(overview, "Agent 链路") {
		t.Fatalf("expected zh-CN overview chrome in output: %q", overview)
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(model)
	inspect := m.View()
	for _, anchor := range []string{"selected", "id", "status", "role", "direct_user_session", "inspect"} {
		if !strings.Contains(inspect, anchor) {
			t.Fatalf("expected inspect to keep literal diagnostic anchor %q:\n%s", anchor, inspect)
		}
	}
	if !strings.Contains(inspect, "检查") || !strings.Contains(inspect, "选中 agent") {
		t.Fatalf("expected zh-CN inspect chrome in output: %q", inspect)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}})
	m = next.(model)
	replay := m.View()
	for _, anchor := range []string{"replay", "run_id", "terminal_state"} {
		if !strings.Contains(replay, anchor) {
			t.Fatalf("expected replay to keep literal diagnostic anchor %q:\n%s", anchor, replay)
		}
	}
	if !strings.Contains(replay, "会话连续性") || !strings.Contains(replay, "操作动作") {
		t.Fatalf("expected zh-CN replay chrome in output: %q", replay)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	m = next.(model)
	help := m.View()
	for _, anchor := range []string{"overview", "inspect", "replay", "help"} {
		if !strings.Contains(help, anchor) {
			t.Fatalf("expected help to keep literal mode anchor %q:\n%s", anchor, help)
		}
	}
}

func TestUnknownAndMissingLocaleFallbackToEnglish(t *testing.T) {
	f := demoFrame()
	f.Locale = "bad-locale"
	out := initialModel(f, true).View()
	if !strings.Contains(out, "Overview") || strings.Contains(out, "总览") {
		t.Fatalf("expected English fallback for unknown locale: %q", out)
	}

	f.Locale = ""
	out = initialModel(f, true).View()
	if !strings.Contains(out, "Overview") {
		t.Fatalf("expected English fallback for missing locale: %q", out)
	}
}

func TestRoleSkinsHaveDistinctAnsiTreatment(t *testing.T) {
	previous := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	t.Cleanup(func() {
		lipgloss.SetColorProfile(previous)
	})
	seen := map[string]string{}
	for _, skin := range []string{"CTRL", "CODE", "TEST", "REV", "ARCH", "GATE"} {
		rendered := roleStyle(false, skin).Render("sample")
		if !strings.Contains(rendered, "\x1b[") {
			t.Fatalf("expected ANSI styling for %s, got %q", skin, rendered)
		}
		if previous, exists := seen[rendered]; exists {
			t.Fatalf("expected distinct styling for %s and %s, both %q", skin, previous, rendered)
		}
		seen[rendered] = skin
	}
}

func TestRoleSkinColorsDisappearWithNoAnsi(t *testing.T) {
	for _, skin := range []string{"CTRL", "CODE", "TEST", "REV", "ARCH", "GATE"} {
		rendered := roleStyle(true, skin).Render("sample")
		if rendered != "sample" || strings.Contains(rendered, "\x1b[") {
			t.Fatalf("expected plain no-ANSI rendering for %s, got %q", skin, rendered)
		}
	}
}

func TestModeKeyboardReachability(t *testing.T) {
	m := initialModel(demoFrame(), true)
	keys := []struct {
		key  string
		want mode
	}{
		{"tab", modeInspect},
		{"tab", modeReplay},
		{"tab", modeHelp},
		{"esc", modeOverview},
		{"enter", modeInspect},
		{"r", modeReplay},
		{"?", modeHelp},
	}
	for _, step := range keys {
		next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(step.key)})
		m = next.(model)
		if m.mode != step.want {
			t.Fatalf("key %q: expected %s, got %s", step.key, step.want, m.mode)
		}
	}
}

func TestInteractionHintVisibleInOverviewAndInspect(t *testing.T) {
	for _, mode := range []string{"overview", "inspect"} {
		out := renderDemo(true, mode, "coder-1", 100, 28)
		if !strings.Contains(out, "Controller CLI pane") {
			t.Fatalf("%s missing Controller CLI pane hint:\n%s", mode, out)
		}
	}
}

func TestOperatorActionsHaveContentNotNone(t *testing.T) {
	out := renderDemo(true, "inspect", "coder-1", 100, 28)
	for _, want := range []string{"copy_attach_command", "replay_evidence", "continue_run", "[r]", "[-]"} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected Operator actions to include %q:\n%s", want, out)
		}
	}
	opsAt := strings.Index(out, "Operator actions")
	if opsAt < 0 {
		t.Fatalf("Operator actions panel missing")
	}
	tail := out[opsAt:]
	end := strings.Index(tail[1:], "+--")
	if end > 0 {
		if strings.Contains(strings.Split(tail[:end+1], "\n")[1], " none ") {
			t.Fatalf("Operator actions still rendered as none:\n%s", tail[:end+1])
		}
	}
}

func TestInspectShowsControllerPaneCallout(t *testing.T) {
	out := renderDemo(true, "inspect", "coder-1", 100, 28)
	if !strings.Contains(out, "Run in Controller pane:") {
		t.Fatalf("inspect missing Controller pane callout:\n%s", out)
	}
	if !strings.Contains(out, "tmux attach -t holp-worker-demo") {
		t.Fatalf("inspect missing attach_command in callout:\n%s", out)
	}
}

func TestHelpForMissingSocketIsMultiLineWithLauncherHint(t *testing.T) {
	text := helpForMissingSocket()
	lines := strings.Split(text, "\n")
	if len(lines) < 6 {
		t.Fatalf("expected multi-line hint, got %d lines:\n%s", len(lines), text)
	}
	for _, want := range []string{"harness:workspace:tui:cmux", "Controller CLI pane", "Sidecar", "--demo"} {
		if !strings.Contains(text, want) {
			t.Fatalf("expected hint to mention %q:\n%s", want, text)
		}
	}
}

func TestStatusBarWrapsInsteadOfTruncating(t *testing.T) {
	for _, width := range []int{100, 72} {
		out := renderDemo(true, "overview", "", width, 28)
		lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
		last := lines[len(lines)-1]
		if strings.HasSuffix(strings.TrimSpace(last), "...") {
			t.Fatalf("width=%d status truncated with ...: %q", width, last)
		}
		joined := strings.Join(lines[len(lines)-3:], "\n")
		if !strings.Contains(joined, "q quit") {
			t.Fatalf("width=%d status missing q quit hint:\n%s", width, joined)
		}
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
