// ax-task-runner: a from-scratch AX runner (google/ax docs/runner.md, "Write a runner from scratch").
// It differs from the default runner in one way that matters to the lab: when spec.command exits,
// it writes <workspace>/.apl/result.json, because the AX control plane does not read exit status (L-006).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

// Only the fields this runner uses. yaml.v3 ignores unknown fields, so newer control planes still decode.
type task struct {
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Command []string `yaml:"command"`
		Env     []struct {
			Name  string `yaml:"name"`
			Value string `yaml:"value"`
		} `yaml:"env"`
		Workspace *struct {
			Name string `yaml:"name"`
			Path string `yaml:"path"`
		} `yaml:"workspace"`
		Debug bool `yaml:"debug"`
	} `yaml:"spec"`
}

type workspace struct {
	Spec struct {
		Git []struct {
			Name   string `yaml:"name"`
			Repo   string `yaml:"repo"`
			Branch string `yaml:"branch"`
			Dir    string `yaml:"dir"`
			Depth  int    `yaml:"depth"`
		} `yaml:"git"`
		Files []struct {
			Path    string `yaml:"path"`
			Content string `yaml:"content"`
		} `yaml:"files"`
		MCP    any `yaml:"mcp"`
		Skills *struct {
			Path string `yaml:"path"`
		} `yaml:"skills"`
	} `yaml:"spec"`
}

type result struct {
	ExitCode      int    `json:"exit_code"`
	StartedAt     string `json:"started_at"`
	EndedAt       string `json:"ended_at"`
	CommandSHA256 string `json:"command_sha256"`
}

func main() {
	taskFile := flag.String("task-file", "", "read the Task from this file instead of AX_TASK_YAML")
	wsFile := flag.String("workspace-file", "", "read the Workspace from this file instead of AX_WORKSPACE_YAML")
	port := flag.Int("port", 80, "probe port")
	metaAddr := flag.String("metadata-addr", "127.0.0.1:8099", "loopback metadata address")
	wsRoot := flag.String("workspace-root", "", "override the workspace path (local testing)")
	grace := flag.Duration("grace", 10*time.Second, "SIGTERM grace period before SIGKILL")
	flag.Parse()

	// Catch SIGTERM before anything else so an early stop is never lost.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)

	taskRaw := readSpec(*taskFile, "AX_TASK_YAML")
	wsRaw := readSpec(*wsFile, "AX_WORKSPACE_YAML")
	var t task
	if err := yaml.Unmarshal(taskRaw, &t); err != nil {
		slog.Error("cannot decode task", "error", err)
	}
	var ws *workspace
	if len(wsRaw) > 0 {
		ws = &workspace{}
		if err := yaml.Unmarshal(wsRaw, ws); err != nil {
			slog.Error("cannot decode workspace", "error", err)
			ws = nil
		}
	}
	wsPath := "/workspace"
	if t.Spec.Workspace != nil && t.Spec.Workspace.Path != "" {
		wsPath = t.Spec.Workspace.Path
	}
	if *wsRoot != "" {
		wsPath = *wsRoot
	}
	if t.Spec.Debug {
		// Guest services (agent-substrate/env gRPC) are not implemented; never served, debug or not.
		slog.Warn("spec.debug requested but this runner does not serve guest services; ax ssh will not work")
	}

	var ready atomic.Bool
	probe := http.NewServeMux()
	probe.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	probe.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready.Load() {
			http.Error(w, "workspace not ready", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ready")
	})
	// Lets an in-cluster collector fetch the outcome through the router without ax ssh (debug off).
	probe.HandleFunc("/apl/result", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(wsPath, ".apl", "result.json"))
	})
	go serve(fmt.Sprintf(":%d", *port), probe)

	meta := http.NewServeMux()
	meta.HandleFunc("/metadata/v1alpha1/ax/task", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/yaml")
		w.Write(taskRaw)
	})
	meta.HandleFunc("/metadata/v1alpha1/ax/workspace", func(w http.ResponseWriter, _ *http.Request) {
		if len(wsRaw) == 0 {
			http.NotFound(w, nil)
			return
		}
		w.Header().Set("Content-Type", "application/yaml")
		w.Write(wsRaw)
	})
	if host, _, _ := net.SplitHostPort(*metaAddr); !net.ParseIP(host).IsLoopback() {
		slog.Error("metadata address must be loopback", "addr", *metaAddr)
		os.Exit(2)
	}
	go serve(*metaAddr, meta)

	if err := prepareOnce(wsPath, ws); err != nil {
		slog.Error("workspace preparation failed; staying not-ready and not starting the command", "error", err)
		waitForStop(sigs, nil, *grace)
		return
	}
	ready.Store(true)

	var sup *supervisor
	if len(t.Spec.Command) > 0 {
		env := append(os.Environ(), "AX_METADATA_URL=http://"+*metaAddr)
		for _, e := range t.Spec.Env {
			env = append(env, e.Name+"="+e.Value)
		}
		sup = start(t.Spec.Command, wsPath, env)
	} else {
		slog.Info("task has no spec.command; serving until stopped")
	}
	waitForStop(sigs, sup, *grace)
}

func readSpec(file, envName string) []byte {
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			slog.Error("cannot read spec file", "file", file, "error", err)
		}
		return b
	}
	return []byte(os.Getenv(envName))
}

func serve(addr string, h http.Handler) {
	if err := http.ListenAndServe(addr, h); err != nil {
		slog.Error("server stopped", "addr", addr, "error", err)
		os.Exit(1)
	}
}

// prepareOnce sets up the workspace on first boot only; resume restores /workspace and must not re-clone.
func prepareOnce(wsPath string, ws *workspace) error {
	marker := filepath.Join(wsPath, ".apl", "prepared")
	if _, err := os.Stat(marker); err == nil {
		slog.Info("workspace already prepared; skipping", "marker", marker)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		return err
	}
	if ws != nil {
		for _, g := range ws.Spec.Git {
			dir := g.Dir
			if dir == "" {
				dir = g.Name
			}
			if dir == "" {
				dir = strings.TrimSuffix(filepath.Base(g.Repo), ".git")
			}
			args := []string{"clone"}
			if g.Branch != "" {
				args = append(args, "--branch", g.Branch)
			}
			if g.Depth > 0 {
				args = append(args, "--depth", fmt.Sprint(g.Depth))
			}
			args = append(args, "--", g.Repo, filepath.Join(wsPath, dir))
			if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("git clone %s: %w: %s", g.Repo, err, out)
			}
		}
		for _, f := range ws.Spec.Files {
			p, err := inside(wsPath, f.Path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(p, []byte(f.Content), 0o644); err != nil {
				return err
			}
		}
		if ws.Spec.Skills != nil && ws.Spec.Skills.Path != "" {
			p, err := inside(wsPath, ws.Spec.Skills.Path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		}
		if ws.Spec.MCP != nil {
			// This runner's own location; the default runner's MCP layout is not reproduced.
			b, _ := json.MarshalIndent(ws.Spec.MCP, "", "  ")
			if err := os.WriteFile(filepath.Join(wsPath, ".apl", "mcp.json"), b, 0o644); err != nil {
				return err
			}
		}
	}
	return os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339Nano)+"\n"), 0o644)
}

// inside resolves a workspace-relative path and rejects escapes such as "../etc/passwd".
func inside(root, rel string) (string, error) {
	p := filepath.Join(root, strings.TrimPrefix(rel, "/"))
	if p != root && !strings.HasPrefix(p, filepath.Clean(root)+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes the workspace", rel)
	}
	return p, nil
}

type supervisor struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func start(argv []string, dir string, env []string) *supervisor {
	// argv elements cannot contain NUL, so NUL-joining is unambiguous and easy to recompute in any language.
	sum := sha256.Sum256([]byte(strings.Join(argv, "\x00")))
	cmdSHA := hex.EncodeToString(sum[:])
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = dir, env
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	s := &supervisor{cmd: cmd, done: make(chan struct{})}
	started := time.Now().UTC()
	if err := cmd.Start(); err != nil {
		slog.Error("command did not start", "error", err)
		writeResult(dir, result{ExitCode: 127, StartedAt: stamp(started), EndedAt: stamp(time.Now().UTC()), CommandSHA256: cmdSHA})
		close(s.done)
		return s
	}
	slog.Info("command started", "pid", cmd.Process.Pid)
	go func() {
		err := cmd.Wait()
		code := cmd.ProcessState.ExitCode()
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code = 128 + int(ws.Signal())
		} else if err != nil && code < 0 {
			code = 1
		}
		writeResult(dir, result{ExitCode: code, StartedAt: stamp(started), EndedAt: stamp(time.Now().UTC()), CommandSHA256: cmdSHA})
		slog.Info("command exited; runner stays up", "exitCode", code)
		close(s.done)
	}()
	return s
}

// shortcut: no PID-1 zombie reaping of orphans outside the command's process group; add a Wait4(-1) reaper if long-lived daemons appear.
func waitForStop(sigs chan os.Signal, s *supervisor, grace time.Duration) {
	sig := <-sigs
	slog.Info("stop requested", "signal", sig.String())
	if s == nil || s.cmd.Process == nil {
		return
	}
	pgid := s.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-s.done:
	case <-time.After(grace):
		slog.Warn("grace period elapsed; killing process group", "grace", grace.String())
	}
	_ = syscall.Kill(-pgid, syscall.SIGKILL) // also reaps stragglers left in the group after the leader exits
	<-s.done
}

var resultMu sync.Mutex

func writeResult(dir string, r result) {
	resultMu.Lock()
	defer resultMu.Unlock()
	p := filepath.Join(dir, ".apl", "result.json")
	b := must(json.MarshalIndent(r, "", "  "))
	tmp := p + ".tmp"
	if err := errors.Join(os.MkdirAll(filepath.Dir(p), 0o755), os.WriteFile(tmp, append(b, '\n'), 0o644), os.Rename(tmp, p)); err != nil {
		slog.Error("cannot write result", "error", err)
	}
}

func stamp(t time.Time) string { return t.Format(time.RFC3339Nano) }

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
