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

type chromeMessages struct {
	AppTitle      string
	Overview      string
	Inspect       string
	Replay        string
	Help          string
	Chain         string
	Summary       string
	Timeline      string
	Evidence      string
	Failures      string
	Affordances   string
	Continuity    string
	SelectedAgent string
	NoFailures    string
	Pending       string
	None          string
	Keys          string
	HelpText      []string
}

var chromeCatalog = map[string]chromeMessages{
	"en-US": {
		AppTitle:      "HOLP Harness Workspace",
		Overview:      "Overview",
		Inspect:       "Inspect",
		Replay:        "Replay",
		Help:          "Help",
		Chain:         "Agent chain",
		Summary:       "Run summary",
		Timeline:      "Timeline",
		Evidence:      "Evidence",
		Failures:      "Failures",
		Affordances:   "Operator actions",
		Continuity:    "Session continuity",
		SelectedAgent: "Selected agent",
		NoFailures:    "No blocking failure recorded",
		Pending:       "pending",
		None:          "none",
		Keys:          "tab mode | j/k select | enter inspect | r replay | f follow | c copy marker | ? help | q quit",
		HelpText: []string{
			"tab: cycle overview / inspect / replay / help",
			"j/k or arrows: select an agent and open inspect",
			"enter: inspect selected agent",
			"esc: return to overview",
			"r: open replay review",
			"f: ask broker to follow selected agent",
			"c: marks copy intent only; real clipboard integration is not implied",
			"q: quit the TUI",
			"cancel remains confirmation-driven; interrupt stays unsupported unless public-wire evidence says otherwise",
		},
	},
	"zh-CN": {
		AppTitle:      "HOLP Harness Workspace",
		Overview:      "总览",
		Inspect:       "检查",
		Replay:        "复盘",
		Help:          "帮助",
		Chain:         "Agent 链路",
		Summary:       "运行摘要",
		Timeline:      "时间线",
		Evidence:      "证据",
		Failures:      "失败",
		Affordances:   "操作动作",
		Continuity:    "会话连续性",
		SelectedAgent: "选中 agent",
		NoFailures:    "没有记录阻塞失败",
		Pending:       "pending",
		None:          "none",
		Keys:          "tab 切换 | j/k 选择 | enter inspect | r replay | f follow | c copy marker | ? help | q quit",
		HelpText: []string{
			"tab: 切换 overview / inspect / replay / help",
			"j/k 或方向键: 选择 agent 并进入 inspect",
			"enter: inspect selected agent",
			"esc: 回到 overview",
			"r: 打开 replay 复盘",
			"f: 让 broker follow selected agent",
			"c: 只记录 copy intent；不暗示真实剪贴板集成",
			"q: 退出 TUI",
			"cancel 仍需要二次确认；interrupt 仍 unsupported，除非 public-wire evidence 证明可用",
		},
	},
}

type frame struct {
	SchemaVersion  string       `json:"schema_version"`
	Locale         string       `json:"locale"`
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
	ReplayWritten  string       `json:"replay_written_at"`
	Overview       overview     `json:"overview"`
	Inspect        inspectFrame `json:"inspect"`
	Continuity     continuity   `json:"continuity"`
}

type cmuxManifest struct {
	SchemaVersion  string                 `json:"schema_version"`
	Surfaces       map[string]cmuxSurface `json:"surfaces"`
	DegradedReason []string               `json:"degraded_reasons"`
}

type cmuxSurface struct {
	SurfaceID string `json:"surface_id"`
	PaneID    string `json:"pane_id"`
	Agent     string `json:"agent"`
}

type agent struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Role     string `json:"role"`
	RoleSkin string `json:"role_skin"`
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
	Chain         []chainNode   `json:"chain"`
	WorkerPreview workerPreview `json:"worker_preview"`
	Evidence      evidence      `json:"evidence"`
}

type chainNode struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Skin    string `json:"skin"`
	State   string `json:"state"`
	AgentID string `json:"agentId"`
}

type workerPreview struct {
	RenderedText string `json:"renderedText"`
}

type evidence struct {
	LatestEvent string `json:"latest_event"`
	Provenance  string `json:"provenance"`
}

type valueMap map[string]any

type inspectFrame struct {
	SelectedAgentID string        `json:"selectedAgentId"`
	SelectedAgent   inspectAgent  `json:"selectedAgent"`
	Inspect         inspectDetail `json:"inspect"`
	Empty           bool          `json:"empty"`
}

type inspectAgent struct {
	ID              string           `json:"id"`
	Status          string           `json:"status"`
	RoleSkin        string           `json:"roleSkin"`
	OwnerVerified   string           `json:"owner_verified"`
	RuntimeSurfaces []map[string]any `json:"runtime_surfaces"`
}

type inspectDetail struct {
	AgentID      string           `json:"agent_id"`
	Sections     []inspectSection `json:"sections"`
	Output       inspectOutput    `json:"output"`
	EvidenceRefs []evidenceRef    `json:"evidenceRefs"`
}

type inspectSection struct {
	Title string       `json:"title"`
	Rows  []inspectRow `json:"rows"`
}

type inspectRow struct {
	Label    string `json:"label"`
	Value    string `json:"value"`
	Anchor   string `json:"anchor"`
	Priority string `json:"priority"`
	Kind     string `json:"kind"`
}

type inspectOutput struct {
	State string `json:"state"`
	Text  string `json:"text"`
}

type evidenceRef struct {
	Ref   string `json:"ref"`
	RunID string `json:"run_id"`
	Seq   int    `json:"seq"`
}

type continuity struct {
	ReplayOnly    bool   `json:"replay_only"`
	CanContinue   bool   `json:"can_continue"`
	CanRerun      bool   `json:"can_rerun"`
	CanInspect    bool   `json:"can_inspect"`
	CanCopy       bool   `json:"can_copy"`
	OwnerVerified string `json:"owner_verified"`
	TerminalState string `json:"terminal_state"`
}

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
	manifest   *cmuxManifest
}

func initialModel(f frame, noANSI bool) model {
	return initialModelWithCmuxManifest(f, noANSI, nil)
}

func initialModelWithCmuxManifest(f frame, noANSI bool, manifest *cmuxManifest) model {
	vp := viewport.New(80, 18)
	m := model{
		frame:    f,
		mode:     modeOverview,
		noANSI:   noANSI,
		viewport: vp,
		help:     help.New(),
		manifest: manifest,
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
	msg := m.chrome()
	title := msg.AppTitle
	if m.frame.Overview.Title != "" {
		title = m.frame.Overview.Title
	}
	header := headerStyle(m.noANSI).Render(fmt.Sprintf("%s | %s", title, m.mode))
	status := subtleStyle(m.noANSI).Render(fmt.Sprintf(
		"run_id=%s selected=%s mode=%s | %s",
		fallback(m.frame.RunID, msg.Pending),
		m.selectedAgentID(),
		m.mode,
		msg.Keys,
	))
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
	msg := m.chrome()
	lines := []string{
		panelTitle(m.noANSI, "CTRL", msg.Overview+" - "+msg.Summary),
		"run_id: " + fallback(m.frame.RunID, msg.Pending),
		"schema_version: " + fallback(m.frame.SchemaVersion, msg.Pending),
		"controller_entry: " + m.controllerEntryStatus(),
		"degraded_reasons: " + joinOrNone(m.degradedReasons(), msg.None),
		"worker_session: " + fallback(m.frame.WorkerSession, msg.Pending),
		"attach_command: " + fallback(m.frame.AttachCommand, msg.Pending),
		"latest_event: " + fallback(m.frame.Overview.Evidence.LatestEvent, msg.Pending),
		"approval: " + summarizeMap(m.frame.Approval, msg.Pending),
		"terminal: " + summarizeMap(m.frame.Terminal, msg.Pending),
		"gate: " + summarizeMap(m.frame.Gate, msg.Pending),
		"next_action: " + m.nextAction(),
		"preview: " + fallback(flatten(m.frame.Overview.WorkerPreview.RenderedText), msg.Pending),
		"",
		panelTitle(m.noANSI, "GATE", msg.Chain),
	}
	lines = append(lines, m.chainLines()...)
	lines = append(lines, "", panelTitle(m.noANSI, "REV", msg.Failures))
	if len(m.frame.Failures) == 0 {
		lines = append(lines, msg.NoFailures)
	} else {
		for _, failure := range m.frame.Failures {
			lines = append(lines, "- "+failure)
		}
	}
	if m.lastError != "" {
		lines = append(lines, "degraded: "+m.lastError)
	}
	return strings.Join(lines, "\n")
}

func (m model) controllerEntryStatus() string {
	if m.manifest == nil {
		return "controller not verified"
	}
	if surface, ok := m.manifest.Surfaces["controller"]; ok && surface.SurfaceID != "" {
		return "controller pane observed; cmux surface created"
	}
	return "controller missing; cmux pane not verified"
}

func (m model) degradedReasons() []string {
	seen := map[string]bool{}
	reasons := []string{}
	add := func(values []string) {
		for _, value := range values {
			if value == "" || seen[value] {
				continue
			}
			seen[value] = true
			reasons = append(reasons, value)
		}
	}
	add(m.frame.DegradedReason)
	if m.manifest != nil {
		add(m.manifest.DegradedReason)
	}
	return reasons
}

func (m model) inspectBody() string {
	msg := m.chrome()
	selected := m.selectedAgent()
	lines := []string{
		panelTitle(m.noANSI, selected.RoleSkin, msg.Inspect+" - "+msg.SelectedAgent),
		"selected: " + m.selectedAgentID(),
		fmt.Sprintf("id=%s status=%s role=%s role_skin=%s", fallback(selected.ID, m.selectedAgentID()), fallback(selected.Status, msg.Pending), fallback(selected.Role, msg.Pending), fallback(selected.RoleSkin, "neutral")),
		"run_id: " + fallback(m.frame.RunID, msg.Pending),
		"worker_session: " + fallback(m.frame.WorkerSession, msg.Pending),
		"attach_command: " + fallback(m.frame.AttachCommand, msg.Pending),
		"",
		panelTitle(m.noANSI, selected.RoleSkin, msg.Chain),
	}
	for _, a := range m.frame.Agents {
		marker := " "
		if a.ID == m.selectedAgentID() {
			marker = ">"
		}
		lines = append(lines, roleStyle(m.noANSI, a.RoleSkin).Render(fmt.Sprintf(
			"%s [%s] %s status=%s role=%s",
			marker,
			fallback(a.RoleSkin, "----"),
			a.ID,
			fallback(a.Status, "unknown"),
			fallback(a.Role, "unknown"),
		)))
	}
	lines = append(lines, "", panelTitle(m.noANSI, selected.RoleSkin, msg.Evidence))
	if m.frame.Inspect.Empty {
		lines = append(lines, "empty=true")
	} else {
		for _, section := range m.frame.Inspect.Inspect.Sections {
			lines = append(lines, section.Title)
			for _, row := range section.Rows {
				lines = append(lines, fmt.Sprintf("- %s=%s", row.Label, row.Value))
			}
		}
		if m.frame.Inspect.Inspect.Output.Text != "" {
			lines = append(lines, "model_output: "+flatten(m.frame.Inspect.Inspect.Output.Text))
		}
	}
	lines = append(lines, "", panelTitle(m.noANSI, "GATE", msg.Timeline))
	for _, entry := range m.frame.Timeline.Entries {
		lines = append(lines, fmt.Sprintf("%s %s %s", entry.Severity, entry.Label, entry.Summary))
	}
	return strings.Join(lines, "\n")
}

func (m model) replayBody() string {
	msg := m.chrome()
	lines := []string{
		panelTitle(m.noANSI, "GATE", msg.Replay),
		"path: " + fallback(m.frame.ReplayPath, msg.Pending),
		"written_at: " + fallback(m.frame.ReplayWritten, msg.Pending),
		"approval: " + summarizeMap(m.frame.Approval, msg.Pending),
		"terminal: " + summarizeMap(m.frame.Terminal, msg.Pending),
		"gate: " + summarizeMap(m.frame.Gate, msg.Pending),
		"next_action: " + m.nextAction(),
		"",
		panelTitle(m.noANSI, "CTRL", msg.Continuity),
		fmt.Sprintf("replay_only=%v", m.frame.Continuity.ReplayOnly),
		fmt.Sprintf("can_continue=%v can_rerun=%v can_copy=%v", m.frame.Continuity.CanContinue, m.frame.Continuity.CanRerun, m.frame.Continuity.CanCopy),
		"owner_verified=" + fallback(m.frame.Continuity.OwnerVerified, msg.Pending),
		"terminal_state=" + fallback(m.frame.Continuity.TerminalState, msg.Pending),
	}
	for _, reason := range m.frame.DegradedReason {
		lines = append(lines, "reason: "+reason)
	}
	lines = append(lines, "", panelTitle(m.noANSI, "TEST", msg.Affordances))
	for _, a := range m.frame.Affordances {
		lines = append(lines, fmt.Sprintf("%s=%s reason=%s", a.Label, a.State, a.ReasonLabel))
	}
	lines = append(lines, "", panelTitle(m.noANSI, "GATE", msg.Timeline))
	for _, entry := range m.frame.Timeline.Entries {
		lines = append(lines, fmt.Sprintf("%s %s %s", entry.Severity, entry.Label, entry.Summary))
	}
	return strings.Join(lines, "\n")
}

func (m model) helpBody() string {
	msg := m.chrome()
	lines := []string{panelTitle(m.noANSI, "CTRL", msg.Help)}
	lines = append(lines, msg.HelpText...)
	return strings.Join(lines, "\n")
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

func (m model) chrome() chromeMessages {
	if messages, ok := chromeCatalog[m.frame.Locale]; ok {
		return messages
	}
	return chromeCatalog["en-US"]
}

func (m model) nextAction() string {
	if mapString(m.frame.Approval, "state") == "requested" {
		return "approve --decision approved|rejected --reason ..."
	}
	if summarizeMap(m.frame.Terminal, "") != "" {
		return "review terminal result"
	}
	if len(m.frame.Failures) > 0 {
		return "inspect failure reason"
	}
	if m.frame.RunID == "" {
		return "ask Controller to run --goal <human goal> --worker auto"
	}
	if m.frame.WorkerSession != "" && m.frame.AttachCommand != "" {
		return "worker session attachable"
	}
	return "wait for worker terminal result"
}

func (m model) selectedAgent() agent {
	if len(m.frame.Agents) == 0 {
		return agent{ID: m.selectedAgentID()}
	}
	return m.frame.Agents[m.selected]
}

func (m model) chainLines() []string {
	if len(m.frame.Overview.Chain) == 0 {
		lines := make([]string, 0, len(m.frame.Agents))
		for _, a := range m.frame.Agents {
			lines = append(lines, roleStyle(m.noANSI, a.RoleSkin).Render(fmt.Sprintf(
				"[%s] %s status=%s role=%s",
				fallback(a.RoleSkin, "----"),
				a.ID,
				fallback(a.Status, "unknown"),
				fallback(a.Role, "unknown"),
			)))
		}
		return lines
	}
	lines := make([]string, 0, len(m.frame.Overview.Chain))
	for _, node := range m.frame.Overview.Chain {
		lines = append(lines, roleStyle(m.noANSI, node.Skin).Render(fmt.Sprintf(
			"[%s] %s state=%s id=%s",
			fallback(node.Skin, "----"),
			fallback(node.Label, node.ID),
			fallback(node.State, "unknown"),
			fallback(node.AgentID, node.ID),
		)))
	}
	return lines
}

func headerStyle(noANSI bool) lipgloss.Style {
	if noANSI {
		return lipgloss.NewStyle()
	}
	return lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("39"))
}

func subtleStyle(noANSI bool) lipgloss.Style {
	if noANSI {
		return lipgloss.NewStyle()
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
}

func panelTitle(noANSI bool, skin string, value string) string {
	return roleStyle(noANSI, skin).Bold(true).Render(value)
}

func roleStyle(noANSI bool, skin string) lipgloss.Style {
	if noANSI {
		return lipgloss.NewStyle()
	}
	color := "250"
	switch strings.ToUpper(skin) {
	case "CTRL":
		color = "45"
	case "CODE":
		color = "42"
	case "TEST":
		color = "220"
	case "REV":
		color = "141"
	case "ARCH":
		color = "208"
	case "GATE":
		color = "245"
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(color))
}

func summarizeMap(value valueMap, fallbackValue string) string {
	if len(value) == 0 {
		return fallbackValue
	}
	preferred := []string{"state", "gate_disposition", "review_outcome", "blocking_reason", "reason", "decision", "approval_id"}
	parts := []string{}
	for _, key := range preferred {
		if raw, ok := value[key]; ok {
			parts = append(parts, fmt.Sprintf("%s=%v", key, raw))
		}
	}
	if len(parts) == 0 {
		for key, raw := range value {
			parts = append(parts, fmt.Sprintf("%s=%v", key, raw))
			if len(parts) >= 3 {
				break
			}
		}
	}
	return strings.Join(parts, " ")
}

func mapString(value valueMap, key string) string {
	if raw, ok := value[key]; ok {
		if text, ok := raw.(string); ok {
			return text
		}
	}
	return ""
}

func joinOrNone(values []string, none string) string {
	if len(values) == 0 {
		return none
	}
	return strings.Join(values, ", ")
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
		Locale:        "en-US",
		Mode:          modeOverview,
		SelectedAgent: "coder-1",
		Agents: []agent{{
			ID:       "controller",
			Status:   "ready",
			Role:     "controller",
			RoleSkin: "CTRL",
		}, {
			ID:       "coder-1",
			Status:   "active",
			Role:     "coder",
			RoleSkin: "CODE",
		}, {
			ID:       "tester-1",
			Status:   "ready",
			Role:     "tester",
			RoleSkin: "TEST",
		}, {
			ID:       "reviewer-1",
			Status:   "ready",
			Role:     "reviewer",
			RoleSkin: "REV",
		}, {
			ID:       "architect-1",
			Status:   "ready",
			Role:     "architect",
			RoleSkin: "ARCH",
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
			Chain: []chainNode{{
				ID: "controller", Label: "Controller", Skin: "CTRL", State: "active", AgentID: "controller",
			}, {
				ID: "agent:coder-1", Label: "Coder", Skin: "CODE", State: "active", AgentID: "coder-1",
			}, {
				ID: "agent:tester-1", Label: "Tester", Skin: "TEST", State: "idle", AgentID: "tester-1",
			}, {
				ID: "agent:reviewer-1", Label: "Reviewer", Skin: "REV", State: "idle", AgentID: "reviewer-1",
			}, {
				ID: "architect", Label: "Architect", Skin: "ARCH", State: "done", AgentID: "architect-1",
			}, {
				ID: "gate", Label: "Gate", Skin: "GATE", State: "unknown", AgentID: "gate",
			}},
			WorkerPreview: workerPreview{
				RenderedText: "deterministic demo frame",
			},
			Evidence: evidence{LatestEvent: "run.run_started#1", Provenance: "smoke_script"},
		},
		Inspect: inspectFrame{
			SelectedAgentID: "coder-1",
			SelectedAgent: inspectAgent{
				ID:            "coder-1",
				Status:        "active",
				RoleSkin:      "CODE",
				OwnerVerified: "verified",
			},
			Inspect: inspectDetail{
				AgentID: "coder-1",
				Sections: []inspectSection{{
					Title: "identity",
					Rows: []inspectRow{{
						Label: "runtime_surface", Value: "direct_user_session", Priority: "identity",
					}, {
						Label: "attach_command", Value: "tmux attach -t holp-worker-demo", Anchor: "attach_command",
					}},
				}},
				Output: inspectOutput{State: "captured", Text: "deterministic demo frame"},
				EvidenceRefs: []evidenceRef{{
					Ref: "run.run_started#1", RunID: "run_demo", Seq: 1,
				}},
			},
		},
		Continuity: continuity{
			ReplayOnly:    false,
			CanContinue:   true,
			CanRerun:      false,
			CanInspect:    true,
			CanCopy:       true,
			OwnerVerified: "verified",
			TerminalState: "merged",
		},
		ReplayPath: "/tmp/holp-harness-workspace/demo/replay.json",
	}
}

func loadCmuxManifest(path string) *cmuxManifest {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var manifest cmuxManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil
	}
	if manifest.SchemaVersion != "HolpHarnessWorkspaceCmuxManifest.v1" {
		return nil
	}
	return &manifest
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
	m := initialModelWithCmuxManifest(frame{}, *noANSI, loadCmuxManifest(os.Getenv("HOLP_HARNESS_CMUX_MANIFEST_PATH")))
	m.socketPath = socketPath
	program := tea.NewProgram(m, tea.WithAltScreen())
	go streamBrokerFrames(socketPath, program)
	if _, err := program.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
