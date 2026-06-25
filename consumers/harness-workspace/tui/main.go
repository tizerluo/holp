package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type mode string

const (
	modeOverview mode = "overview"
	modeInspect  mode = "inspect"
	modeReplay   mode = "replay"
	modeHelp     mode = "help"
)

type frame struct {
	SchemaVersion  string       `json:"schema_version"`
	Mode           mode         `json:"mode"`
	SelectedAgent  string       `json:"selected_agent"`
	Agents         []agent      `json:"agents"`
	RunID          string       `json:"run_id"`
	WorkerSession  string       `json:"worker_session"`
	AttachCommand  string       `json:"attach_command"`
	Timeline       timeline     `json:"timeline"`
	Gate           valueMap     `json:"gate"`
	Approval       valueMap     `json:"approval"`
	Terminal       valueMap     `json:"terminal"`
	Failures       []string     `json:"failures"`
	Affordances    []affordance `json:"affordances"`
	DegradedReason []string     `json:"degraded_reasons"`
	ReplayPath     string       `json:"replay_path"`
	Overview       overview     `json:"overview"`
}

type agent struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Role   string `json:"role"`
}

type timeline struct {
	Entries []timelineEntry `json:"entries"`
}

type timelineEntry struct {
	Label    string `json:"label"`
	Severity string `json:"severity"`
	Summary  string `json:"summary"`
}

type affordance struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	State       string `json:"state"`
	ReasonLabel string `json:"reason_label"`
}

type overview struct {
	Title         string        `json:"title"`
	WorkerPreview workerPreview `json:"worker_preview"`
	Evidence      evidence      `json:"evidence"`
}

type workerPreview struct {
	RenderedText string `json:"renderedText"`
}

type evidence struct {
	LatestEvent string `json:"latest_event"`
	Provenance  string `json:"provenance"`
}

type valueMap map[string]any

type frameMsg frame
type errMsg error

const maxBrokerFrameBytes = 4 * 1024 * 1024
const followResponseTimeout = 2 * time.Second

type model struct {
	frame      frame
	mode       mode
	selected   int
	noANSI     bool
	socketPath string
	quitting   bool
	lastError  string
	viewport   viewport.Model
	help       help.Model
}

func initialModel(f frame, noANSI bool) model {
	vp := viewport.New(80, 18)
	m := model{
		frame:    f,
		mode:     modeOverview,
		noANSI:   noANSI,
		viewport: vp,
		help:     help.New(),
	}
	m.syncSelected()
	m.viewport.SetContent(m.body())
	return m
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case frameMsg:
		previousSelected := m.selectedAgentID()
		m.frame = frame(msg)
		if !m.selectAgent(previousSelected) {
			m.syncSelected()
		}
		m.viewport.SetContent(m.body())
		return m, nil
	case errMsg:
		m.lastError = msg.Error()
		m.viewport.SetContent(m.body())
		return m, nil
	case tea.WindowSizeMsg:
		m.viewport.Width = msg.Width
		if msg.Height > 3 {
			m.viewport.Height = msg.Height - 3
		}
		m.viewport.SetContent(m.body())
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "?", "h":
			m.mode = modeHelp
		case "esc":
			m.mode = modeOverview
		case "enter":
			m.mode = modeInspect
		case "tab":
			m.mode = nextMode(m.mode)
		case "j", "down":
			if len(m.frame.Agents) > 0 && m.selected < len(m.frame.Agents)-1 {
				m.selected++
			}
			m.mode = modeInspect
		case "k", "up":
			if m.selected > 0 {
				m.selected--
			}
			m.mode = modeInspect
		case "r":
			m.mode = modeReplay
		case "f":
			m.mode = modeInspect
			if m.socketPath != "" && m.selectedAgentID() != "none" {
				m.viewport.SetContent(m.body())
				return m, sendFollowCommand(m.socketPath, m.selectedAgentID())
			}
		case "c":
			m.lastError = "copy requested"
		}
		m.viewport.SetContent(m.body())
		return m, nil
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

func (m model) View() string {
	if m.quitting {
		return ""
	}
	title := "HOLP Harness Workspace"
	if m.frame.Overview.Title != "" {
		title = m.frame.Overview.Title
	}
	header := style(m.noANSI, true).Render(fmt.Sprintf("%s | %s", title, m.mode))
	status := fmt.Sprintf("run_id=%s selected=%s q=quit ?=help", fallback(m.frame.RunID, "pending"), m.selectedAgentID())
	if m.lastError != "" {
		status += " degraded=" + m.lastError
	}
	return strings.Join([]string{header, m.viewport.View(), status}, "\n")
}

func (m *model) syncSelected() {
	for i, a := range m.frame.Agents {
		if a.ID == m.frame.SelectedAgent {
			m.selected = i
			return
		}
	}
	if m.selected >= len(m.frame.Agents) {
		m.selected = 0
	}
}

func (m *model) selectAgent(agentID string) bool {
	for i, a := range m.frame.Agents {
		if a.ID == agentID {
			m.selected = i
			return true
		}
	}
	return false
}

func (m model) selectedAgentID() string {
	if len(m.frame.Agents) == 0 {
		return fallback(m.frame.SelectedAgent, "none")
	}
	return m.frame.Agents[m.selected].ID
}

func (m model) body() string {
	switch m.mode {
	case modeInspect:
		return m.inspectBody()
	case modeReplay:
		return m.replayBody()
	case modeHelp:
		return m.helpBody()
	default:
		return m.overviewBody()
	}
}

func (m model) overviewBody() string {
	lines := []string{
		"Overview",
		"run_id: " + fallback(m.frame.RunID, "pending"),
		"worker_session: " + fallback(m.frame.WorkerSession, "pending"),
		"attach_command: " + fallback(m.frame.AttachCommand, "pending"),
		"latest_event: " + fallback(m.frame.Overview.Evidence.LatestEvent, "pending"),
		"preview: " + fallback(flatten(m.frame.Overview.WorkerPreview.RenderedText), "pending"),
	}
	if len(m.frame.Failures) == 0 {
		lines = append(lines, "failures: none")
	} else {
		lines = append(lines, "failures: "+strings.Join(m.frame.Failures, " | "))
	}
	if m.lastError != "" {
		lines = append(lines, "degraded: "+m.lastError)
	}
	return strings.Join(lines, "\n")
}

func (m model) inspectBody() string {
	lines := []string{"Inspect", "agent: " + m.selectedAgentID()}
	for _, a := range m.frame.Agents {
		marker := " "
		if a.ID == m.selectedAgentID() {
			marker = ">"
		}
		lines = append(lines, fmt.Sprintf("%s %s status=%s role=%s", marker, a.ID, fallback(a.Status, "unknown"), fallback(a.Role, "unknown")))
	}
	for _, entry := range m.frame.Timeline.Entries {
		lines = append(lines, fmt.Sprintf("%s %s %s", entry.Severity, entry.Label, entry.Summary))
	}
	return strings.Join(lines, "\n")
}

func (m model) replayBody() string {
	lines := []string{"Replay", "path: " + fallback(m.frame.ReplayPath, "pending")}
	for _, reason := range m.frame.DegradedReason {
		lines = append(lines, "reason: "+reason)
	}
	for _, a := range m.frame.Affordances {
		lines = append(lines, fmt.Sprintf("%s=%s reason=%s", a.Label, a.State, a.ReasonLabel))
	}
	return strings.Join(lines, "\n")
}

func (m model) helpBody() string {
	return "Help\nTab changes mode\nj/k or arrows select agents\nEnter inspects\nEsc returns to overview\nr shows replay\nf follows selected agent\nc marks copy action\nq quits"
}

func nextMode(current mode) mode {
	switch current {
	case modeOverview:
		return modeInspect
	case modeInspect:
		return modeReplay
	case modeReplay:
		return modeHelp
	default:
		return modeOverview
	}
}

func style(noANSI bool, bold bool) lipgloss.Style {
	if noANSI {
		return lipgloss.NewStyle()
	}
	return lipgloss.NewStyle().Bold(bold).Foreground(lipgloss.Color("39"))
}

func fallback(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func flatten(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func demoFrame() frame {
	return frame{
		SchemaVersion: "WorkspaceTuiFrame.v1",
		Mode:          modeOverview,
		SelectedAgent: "fake-agent",
		Agents: []agent{{
			ID:     "fake-agent",
			Status: "ready",
			Role:   "coder",
		}},
		RunID:         "run_demo",
		WorkerSession: "holp-worker-demo",
		AttachCommand: "tmux attach -t holp-worker-demo",
		Timeline: timeline{Entries: []timelineEntry{{
			Label:    "run.run_started#1",
			Severity: "info",
			Summary:  "run started",
		}}},
		Overview: overview{
			Title: "HOLP Harness Workspace",
			WorkerPreview: workerPreview{
				RenderedText: "deterministic demo frame",
			},
			Evidence: evidence{LatestEvent: "run.run_started#1", Provenance: "smoke_script"},
		},
		ReplayPath: "/tmp/holp-harness-workspace/demo/replay.json",
	}
}

type programSender interface {
	Send(tea.Msg)
}

func streamBrokerFrames(socketPath string, sender programSender) {
	if err := consumeBrokerFrames(socketPath, sender.Send); err != nil {
		sender.Send(errMsg(err))
	}
}

type commandResponse struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func sendFollowCommand(socketPath string, agentID string) tea.Cmd {
	return sendFollowCommandWithTimeout(socketPath, agentID, followResponseTimeout)
}

func sendFollowCommandWithTimeout(socketPath string, agentID string, timeout time.Duration) tea.Cmd {
	return func() tea.Msg {
		conn, err := net.DialTimeout("unix", socketPath, timeout)
		if err != nil {
			return errMsg(err)
		}
		defer conn.Close()
		if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
			return errMsg(err)
		}
		if err := json.NewEncoder(conn).Encode(map[string]string{
			"type":  "follow",
			"agent": agentID,
		}); err != nil {
			return errMsg(err)
		}
		scanner := bufio.NewScanner(conn)
		scanner.Buffer(make([]byte, 64*1024), maxBrokerFrameBytes)
		for scanner.Scan() {
			var response commandResponse
			if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
				continue
			}
			if response.Type == "ack" {
				return nil
			}
			if response.Type == "error" {
				return errMsg(fmt.Errorf("%s", response.Message))
			}
		}
		if err := scanner.Err(); err != nil {
			return errMsg(err)
		}
		return errMsg(fmt.Errorf("broker follow response closed"))
	}
}

func consumeBrokerFrames(socketPath string, send func(tea.Msg)) error {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return err
	}
	defer conn.Close()
	return decodeFrames(conn, send)
}

func decodeFrames(conn net.Conn, send func(tea.Msg)) error {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), maxBrokerFrameBytes)
	for scanner.Scan() {
		var f frame
		if err := json.Unmarshal(scanner.Bytes(), &f); err != nil {
			continue
		}
		if f.SchemaVersion == "WorkspaceTuiFrame.v1" {
			send(frameMsg(f))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return fmt.Errorf("broker stream closed")
}

func main() {
	demo := flag.Bool("demo", false, "render a deterministic demo frame")
	noANSI := flag.Bool("no-ansi", false, "disable ANSI styling")
	flag.Parse()

	if *demo {
		m := initialModel(demoFrame(), *noANSI)
		fmt.Println(m.View())
		return
	}

	socketPath := os.Getenv("HOLP_HARNESS_BROKER_SOCKET")
	if socketPath == "" {
		fmt.Fprintln(os.Stderr, "HOLP_HARNESS_BROKER_SOCKET is required")
		os.Exit(1)
	}
	m := initialModel(frame{}, *noANSI)
	m.socketPath = socketPath
	program := tea.NewProgram(m, tea.WithAltScreen())
	go streamBrokerFrames(socketPath, program)
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
