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
	AppTitle         string
	Overview         string
	Inspect          string
	Replay           string
	Help             string
	Chain            string
	ChainMap         string
	Summary          string
	Timeline         string
	Evidence         string
	EvidenceSum      string
	Failures         string
	Affordances      string
	Continuity       string
	SelectedAgent    string
	SelectedDetail   string
	SelectedEvidence string
	WorkerPreview    string
	Output           string
	NoFailures       string
	Pending          string
	None             string
	Keys             string
	HelpText         []string
}

var chromeCatalog = map[string]chromeMessages{
	"en-US": {
		AppTitle:         "HOLP Harness Workspace",
		Overview:         "Overview",
		Inspect:          "Inspect",
		Replay:           "Replay",
		Help:             "Help",
		Chain:            "Agent chain",
		ChainMap:         "Chain Map",
		Summary:          "Run summary",
		Timeline:         "Timeline",
		Evidence:         "Evidence",
		EvidenceSum:      "Evidence Summary",
		Failures:         "Failures",
		Affordances:      "Operator actions",
		Continuity:       "Session continuity",
		SelectedAgent:    "Selected agent",
		SelectedDetail:   "Selected Agent Detail",
		SelectedEvidence: "Selected Evidence",
		WorkerPreview:    "Active Worker Preview",
		Output:           "Output",
		NoFailures:       "No blocking failure recorded",
		Pending:          "pending",
		None:             "none",
		Keys:             "tab mode | j/k select | enter inspect | r replay | f follow | c copy marker | ? help | q quit",
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
		AppTitle:         "HOLP Harness Workspace",
		Overview:         "总览",
		Inspect:          "检查",
		Replay:           "复盘",
		Help:             "帮助",
		Chain:            "Agent 链路",
		ChainMap:         "Chain Map",
		Summary:          "运行摘要",
		Timeline:         "时间线",
		Evidence:         "证据",
		EvidenceSum:      "Evidence Summary",
		Failures:         "失败",
		Affordances:      "操作动作",
		Continuity:       "会话连续性",
		SelectedAgent:    "选中 agent",
		SelectedDetail:   "Selected Agent Detail",
		SelectedEvidence: "Selected Evidence",
		WorkerPreview:    "Active Worker Preview",
		Output:           "Output",
		NoFailures:       "没有记录阻塞失败",
		Pending:          "pending",
		None:             "none",
		Keys:             "tab 切换 | j/k 选择 | enter inspect | r replay | f follow | c copy marker | ? help | q quit",
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
}

func initialModel(f frame, noANSI bool) model {
	vp := viewport.New(80, 40)
	m := model{
		frame:    f,
		mode:     modeOverview,
		noANSI:   noANSI,
		viewport: vp,
		help:     help.New(),
	}
	if validMode(f.Mode) {
		m.mode = f.Mode
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
	status := fmt.Sprintf(
		"run_id=%s selected=%s mode=%s",
		fallback(m.frame.RunID, msg.Pending),
		m.selectedAgentID(),
		m.mode,
	)
	if m.lastError != "" {
		status += " degraded=" + m.lastError
	}
	status += " | " + msg.Keys
	statusWidth := m.viewport.Width
	if statusWidth <= 0 {
		statusWidth = 80
	}
	status = subtleStyle(m.noANSI).Render(fitDisplay(status, statusWidth))
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
	width := m.contentWidth()
	chain := panel(m.noANSI, "GATE", msg.Overview+" - "+msg.ChainMap+" - "+msg.Chain, m.chainLines(), panelWidth(width, 2))
	preview := panel(m.noANSI, "CODE", msg.WorkerPreview, []string{
		fallback(m.frame.Overview.WorkerPreview.RenderedText, msg.Pending),
	}, panelWidth(width, 2))
	evidenceLines := []string{
		"run_id=" + fallback(m.frame.RunID, msg.Pending) + " schema_version=" + fallback(m.frame.SchemaVersion, msg.Pending),
		"worker_session=" + fallback(m.frame.WorkerSession, msg.Pending) + " runtime_surface=" + m.runtimeSurface(msg.Pending),
		"attach_command: " + fallback(m.frame.AttachCommand, msg.Pending),
		"terminal_state=" + fallback(m.frame.Continuity.TerminalState, msg.Pending) + " latest_event=" + fallback(m.frame.Overview.Evidence.LatestEvent, msg.Pending),
		"provenance=" + fallback(m.frame.Overview.Evidence.Provenance, msg.Pending) + " terminal=" + summarizeMap(m.frame.Terminal, msg.Pending),
		"gate: " + summarizeMap(m.frame.Gate, msg.Pending),
	}
	lines := []string{}
	if width >= 88 {
		lines = append(lines, lipgloss.JoinHorizontal(lipgloss.Top, chain, preview))
	} else {
		lines = append(lines, chain, preview)
	}
	lines = append(lines, panel(m.noANSI, "GATE", msg.EvidenceSum, evidenceLines, width))
	if len(m.frame.Failures) == 0 {
		lines = append(lines, panel(m.noANSI, "REV", msg.Failures, []string{msg.NoFailures}, width))
	} else {
		failureLines := make([]string, 0, len(m.frame.Failures))
		for _, failure := range m.frame.Failures {
			failureLines = append(failureLines, "- "+failure)
		}
		lines = append(lines, panel(m.noANSI, "REV", msg.Failures, failureLines, width))
	}
	if m.lastError != "" {
		lines = append(lines, panel(m.noANSI, "GATE", "degraded", []string{m.lastError}, width))
	}
	return strings.Join(lines, "\n")
}

func (m model) runtimeSurface(fallbackValue string) string {
	for _, section := range m.frame.Inspect.Inspect.Sections {
		for _, row := range section.Rows {
			if row.Label == "runtime_surface" && row.Value != "" {
				return row.Value
			}
		}
	}
	return fallbackValue
}

func (m model) inspectBody() string {
	msg := m.chrome()
	selected := m.selectedAgent()
	width := m.contentWidth()
	detail := []string{
		fmt.Sprintf("selected=%s id=%s status=%s role=%s role_skin=%s",
			m.selectedAgentID(),
			fallback(selected.ID, m.selectedAgentID()),
			fallback(selected.Status, msg.Pending),
			fallback(selected.Role, msg.Pending),
			fallback(selected.RoleSkin, "neutral"),
		),
		"run_id=" + fallback(m.frame.RunID, msg.Pending) + " worker_session=" + fallback(m.frame.WorkerSession, msg.Pending),
	}
	detail = append(detail, kvRows([]kv{
		{"attach_command", fallback(m.frame.AttachCommand, msg.Pending)},
		{"owner_verified", fallback(m.frame.Inspect.SelectedAgent.OwnerVerified, msg.Pending)},
	})...)
	lines := []string{
		panel(m.noANSI, selected.RoleSkin, msg.SelectedDetail+" - "+msg.Inspect+" - "+msg.SelectedAgent, detail, width),
		panel(m.noANSI, selected.RoleSkin, msg.ChainMap+" - "+msg.Chain, m.inspectChainSummaryLines(), width),
	}
	evidenceLines := []string{}
	if m.frame.Inspect.Empty {
		evidenceLines = append(evidenceLines, "empty=true")
	} else {
		for _, section := range m.frame.Inspect.Inspect.Sections {
			sectionParts := []string{section.Title}
			for _, row := range section.Rows {
				sectionParts = append(sectionParts, fmt.Sprintf("%s=%s", row.Label, row.Value))
			}
			evidenceLines = append(evidenceLines, strings.Join(sectionParts, " "))
		}
		for _, ref := range m.frame.Inspect.Inspect.EvidenceRefs {
			evidenceLines = append(evidenceLines, fmt.Sprintf("- ref=%s run_id=%s seq=%d", ref.Ref, ref.RunID, ref.Seq))
		}
	}
	if len(evidenceLines) == 0 {
		evidenceLines = append(evidenceLines, msg.None)
	}
	lines = append(lines, panel(m.noANSI, selected.RoleSkin, msg.SelectedEvidence, evidenceLines, width))
	lines = append(lines, panel(m.noANSI, "TEST", msg.Affordances, m.affordanceLines(), width))
	lines = append(lines, panel(m.noANSI, selected.RoleSkin, msg.Output, []string{
		"state=" + fallback(m.frame.Inspect.Inspect.Output.State, msg.Pending),
		fallback(m.frame.Inspect.Inspect.Output.Text, msg.Pending),
	}, width))
	timelineLines := []string{}
	for _, entry := range m.frame.Timeline.Entries {
		timelineLines = append(timelineLines, fmt.Sprintf("%s %s %s", entry.Severity, entry.Label, entry.Summary))
	}
	lines = append(lines, panel(m.noANSI, "GATE", msg.Timeline, fallbackLines(timelineLines, msg.Pending), width))
	return strings.Join(lines, "\n")
}

func (m model) replayBody() string {
	msg := m.chrome()
	width := m.contentWidth()
	lines := []string{panel(m.noANSI, "GATE", msg.Replay, kvRows([]kv{
		{"path", fallback(m.frame.ReplayPath, msg.Pending)},
		{"written_at", fallback(m.frame.ReplayWritten, msg.Pending)},
		{"terminal", summarizeMap(m.frame.Terminal, msg.Pending)},
		{"gate", summarizeMap(m.frame.Gate, msg.Pending)},
	}), width)}
	continuityLines := []string{
		fmt.Sprintf("replay_only=%v", m.frame.Continuity.ReplayOnly),
		fmt.Sprintf("can_continue=%v can_rerun=%v can_copy=%v", m.frame.Continuity.CanContinue, m.frame.Continuity.CanRerun, m.frame.Continuity.CanCopy),
		"owner_verified=" + fallback(m.frame.Continuity.OwnerVerified, msg.Pending),
		"terminal_state=" + fallback(m.frame.Continuity.TerminalState, msg.Pending),
	}
	for _, reason := range m.frame.DegradedReason {
		continuityLines = append(continuityLines, "reason: "+reason)
	}
	lines = append(lines, panel(m.noANSI, "CTRL", msg.Continuity, continuityLines, width))
	lines = append(lines, panel(m.noANSI, "TEST", msg.Affordances, m.affordanceLines(), width))
	timelineLines := []string{}
	for _, entry := range m.frame.Timeline.Entries {
		timelineLines = append(timelineLines, fmt.Sprintf("%s %s %s", entry.Severity, entry.Label, entry.Summary))
	}
	lines = append(lines, panel(m.noANSI, "GATE", msg.Timeline, fallbackLines(timelineLines, msg.Pending), width))
	return strings.Join(lines, "\n")
}

func (m model) helpBody() string {
	msg := m.chrome()
	return panel(m.noANSI, "CTRL", msg.Help, msg.HelpText, m.contentWidth())
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

func validMode(value mode) bool {
	switch value {
	case modeOverview, modeInspect, modeReplay, modeHelp:
		return true
	default:
		return false
	}
}

func (m model) chrome() chromeMessages {
	if messages, ok := chromeCatalog[m.frame.Locale]; ok {
		return messages
	}
	return chromeCatalog["en-US"]
}

func (m model) selectedAgent() agent {
	if len(m.frame.Agents) == 0 {
		return agent{ID: m.selectedAgentID()}
	}
	return m.frame.Agents[m.selected]
}

func (m model) contentWidth() int {
	if m.viewport.Width <= 0 {
		return 80
	}
	if m.viewport.Width < 24 {
		return 24
	}
	return m.viewport.Width
}

func (m model) chainLines() []string {
	if len(m.frame.Overview.Chain) == 0 {
		lines := make([]string, 0, len(m.frame.Agents))
		for _, a := range m.frame.Agents {
			lines = append(lines, roleStyle(m.noANSI, a.RoleSkin).Render(fmt.Sprintf(
				"%s %s status=%s role=%s",
				roleBadge(m.noANSI, a.RoleSkin),
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
			"%s %s -> id=%s state=%s",
			roleBadge(m.noANSI, node.Skin),
			fallback(node.Label, node.ID),
			fallback(node.AgentID, node.ID),
			fallback(node.State, "unknown"),
		)))
	}
	return lines
}

func (m model) inspectChainSummaryLines() []string {
	parts := make([]string, 0, len(m.frame.Agents))
	for _, a := range m.frame.Agents {
		label := a.ID
		if a.ID == m.selectedAgentID() {
			label += "(selected)"
		}
		parts = append(parts, roleStyle(m.noANSI, a.RoleSkin).Render(label))
	}
	if len(parts) == 0 {
		return []string{m.chrome().Pending}
	}
	return []string{strings.Join(parts, " -> ")}
}

func (m model) affordanceLines() []string {
	lines := make([]string, 0, len(m.frame.Affordances))
	for _, a := range m.frame.Affordances {
		lines = append(lines, fmt.Sprintf("%s=%s reason=%s", fallback(a.Label, a.ID), fallback(a.State, "unknown"), fallback(a.ReasonLabel, "none")))
	}
	return fallbackLines(lines, m.chrome().None)
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
	if noANSI {
		return value
	}
	return roleStyle(noANSI, skin).Bold(true).Render(value)
}

func roleBadge(noANSI bool, skin string) string {
	return roleStyle(noANSI, skin).Render("[" + fallback(strings.ToUpper(skin), "----") + "]")
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

type kv struct {
	key   string
	value string
}

func kvRows(rows []kv) []string {
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, row.key+": "+row.value)
	}
	return lines
}

func fallbackLines(lines []string, fallbackValue string) []string {
	if len(lines) == 0 {
		return []string{fallbackValue}
	}
	return lines
}

func panelWidth(total int, columns int) int {
	if columns <= 1 || total < 88 {
		return total
	}
	width := (total - columns + 1) / columns
	if width < 36 {
		return 36
	}
	return width
}

func panel(noANSI bool, skin string, title string, lines []string, width int) string {
	if width < 24 {
		width = 24
	}
	contentWidth := width - 4
	if contentWidth < 8 {
		contentWidth = 8
	}
	body := wrapLines(append([]string{panelTitle(noANSI, skin, title)}, lines...), contentWidth)
	if noANSI {
		border := "+" + strings.Repeat("-", width-2) + "+"
		rendered := []string{border}
		for _, line := range body {
			rendered = append(rendered, "| "+padDisplay(line, contentWidth)+" |")
		}
		rendered = append(rendered, border)
		return strings.Join(rendered, "\n")
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		Padding(0, 1).
		Width(width).
		Render(strings.Join(body, "\n"))
}

func wrapLines(lines []string, width int) []string {
	wrapped := []string{}
	for _, line := range lines {
		wrapped = append(wrapped, wrapText(line, width)...)
	}
	return wrapped
}

func wrapText(value string, width int) []string {
	if width <= 0 {
		return []string{value}
	}
	result := []string{}
	for _, raw := range strings.Split(value, "\n") {
		if raw == "" || lipgloss.Width(raw) <= width {
			result = append(result, raw)
			continue
		}
		current := ""
		for _, word := range strings.Fields(raw) {
			for _, part := range splitDisplay(word, width) {
				if current == "" {
					current = part
					continue
				}
				next := current + " " + part
				if lipgloss.Width(next) <= width {
					current = next
					continue
				}
				result = append(result, current)
				current = part
			}
		}
		if current != "" {
			result = append(result, current)
		}
	}
	return result
}

func splitDisplay(value string, width int) []string {
	if lipgloss.Width(value) <= width {
		return []string{value}
	}
	parts := []string{}
	current := strings.Builder{}
	currentWidth := 0
	for _, r := range value {
		cellWidth := lipgloss.Width(string(r))
		if currentWidth > 0 && currentWidth+cellWidth > width {
			parts = append(parts, current.String())
			current.Reset()
			currentWidth = 0
		}
		current.WriteRune(r)
		currentWidth += cellWidth
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	return parts
}

func padDisplay(value string, width int) string {
	padding := width - lipgloss.Width(value)
	if padding <= 0 {
		return value
	}
	return value + strings.Repeat(" ", padding)
}

func fitDisplay(value string, width int) string {
	if width <= 0 || lipgloss.Width(value) <= width {
		return value
	}
	if width <= 3 {
		return strings.Repeat(".", width)
	}
	return splitDisplay(value, width-3)[0] + "..."
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

func fallback(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
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

func renderDemo(noANSI bool, modeArg string, agentArg string, width int, height int) string {
	f := demoFrame()
	if selectedMode := mode(modeArg); validMode(selectedMode) {
		f.Mode = selectedMode
	}
	if agentArg != "" {
		f.SelectedAgent = agentArg
		f.Inspect.SelectedAgentID = agentArg
	}
	m := initialModel(f, noANSI)
	if agentArg != "" {
		m.selectAgent(agentArg)
	}
	if width > 0 || height > 0 {
		if width <= 0 {
			width = m.viewport.Width
		}
		if height <= 0 {
			height = m.viewport.Height + 3
		}
		m.viewport.Width = width
		content := m.body()
		m.viewport.Height = lipgloss.Height(content)
		if requested := height - 3; requested > m.viewport.Height {
			m.viewport.Height = requested
		}
		m.viewport.SetContent(content)
	}
	return m.View()
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
	demoMode := flag.String("mode", "overview", "demo mode: overview, inspect, replay, or help")
	demoAgent := flag.String("agent", "", "demo selected agent id")
	demoWidth := flag.Int("width", 0, "demo terminal width")
	demoHeight := flag.Int("height", 0, "demo terminal height")
	flag.Parse()

	if *demo {
		fmt.Println(renderDemo(*noANSI, *demoMode, *demoAgent, *demoWidth, *demoHeight))
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
