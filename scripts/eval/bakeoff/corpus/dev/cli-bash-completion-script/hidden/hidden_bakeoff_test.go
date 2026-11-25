package cli_test

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/urfave/cli/v3"
)

// The suite renders the script through the public `completion bash` command and
// drives it in a real bash against a fake application on PATH. The completion
// function is discovered from `complete -p`, so no internal name is assumed.

const hiddenBakeoffApp = "myapp"

const hiddenBakeoffCompletionFlag = "--generate-shell-completion"

// hiddenBakeoffHarness is run as: bash harness.sh <script> <cword> <comp-type> <words...>
const hiddenBakeoffHarness = `
script="$1"; cword_arg="$2"; comp_type="$3"; shift 3
source "$script" || exit 3

spec="$(complete -p "$HB_APP")" || exit 4
fn="${spec##*-F }"
fn="${fn%% *}"
declare -F "$fn" >/dev/null || exit 5

__hb_words() {
  words=("${COMP_WORDS[@]}")
  cword=$COMP_CWORD
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev=""
  if (( cword > 0 )); then prev="${COMP_WORDS[cword-1]}"; fi
}
_get_comp_words_by_ref() { __hb_words; }
__ltrim_colon_completions() { :; }
_comp_ltrim_colon_completions() { :; }
if [[ -z "$HB_NO_INIT" ]]; then
  _init_completion() { COMPREPLY=(); __hb_words; }
  _comp_initialize() { COMPREPLY=(); __hb_words; }
fi

COMP_WORDS=("$@")
COMP_CWORD=$cword_arg
COMP_LINE="${COMP_WORDS[*]}"
COMP_POINT=${#COMP_LINE}
COMP_TYPE=$comp_type
COMP_KEY=9

hb_prev=""
if (( COMP_CWORD > 0 )); then hb_prev="${COMP_WORDS[COMP_CWORD-1]}"; fi
"$fn" "$HB_APP" "${COMP_WORDS[COMP_CWORD]}" "$hb_prev"

printf '%s\n' "${COMPREPLY[@]}" > "$HB_REPLY_FILE"
exit 0
`

const hiddenBakeoffFakeApp = `#!/bin/sh
printf '%s\n' "$@" > "$HB_ARGS_FILE"
cat "$HB_OUTPUT_FILE"
cat "$HB_STDERR_FILE" >&2
`

type hiddenBakeoffRun struct {
	words     []string
	cword     int // index of the word being completed; 0 means the last word
	appOutput string
	appStderr string
	noInit    bool // leave _init_completion undefined, as on bash3 macs
	compType  int  // COMP_TYPE; 0 means a plain TAB
}

type hiddenBakeoffResult struct {
	reply  []string // non-empty COMPREPLY entries
	args   []string // arguments the application was called with
	called bool
	stderr string
}

func (r hiddenBakeoffResult) names() []string {
	names := []string{}
	for _, entry := range r.reply {
		name := strings.TrimSpace(entry)
		if i := strings.IndexAny(name, " \t:"); i >= 0 {
			name = name[:i]
		}
		names = append(names, name)
	}
	return names
}

func hiddenBakeoffRender(t *testing.T, appName, shell string) string {
	t.Helper()
	out := &bytes.Buffer{}
	cmd := &cli.Command{
		Name:                  appName,
		EnableShellCompletion: true,
		// The completion subcommand does not inherit the root command's Writer.
		ConfigureShellCompletionCommand: func(completion *cli.Command) {
			completion.Writer = out
		},
	}
	require.NoError(t, cmd.Run(context.Background(), []string{appName, "completion", shell}))
	return out.String()
}

func hiddenBakeoffRequireBash(t *testing.T) string {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not available")
	}
	return bash
}

func hiddenBakeoffWrite(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte(content), mode))
}

func hiddenBakeoffNonEmptyLines(content string) []string {
	lines := []string{}
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func hiddenBakeoffComplete(t *testing.T, run hiddenBakeoffRun) hiddenBakeoffResult {
	t.Helper()
	bash := hiddenBakeoffRequireBash(t)

	dir := t.TempDir()
	binDir := filepath.Join(dir, "bin")
	require.NoError(t, os.Mkdir(binDir, 0o755))

	scriptPath := filepath.Join(dir, "completion.bash")
	harnessPath := filepath.Join(dir, "harness.sh")
	replyPath := filepath.Join(dir, "reply")
	argsPath := filepath.Join(dir, "args")
	outputPath := filepath.Join(dir, "output")
	stderrPath := filepath.Join(dir, "stderr")

	hiddenBakeoffWrite(t, scriptPath, hiddenBakeoffRender(t, hiddenBakeoffApp, "bash"), 0o644)
	hiddenBakeoffWrite(t, harnessPath, hiddenBakeoffHarness, 0o644)
	hiddenBakeoffWrite(t, outputPath, run.appOutput, 0o644)
	hiddenBakeoffWrite(t, stderrPath, run.appStderr, 0o644)
	hiddenBakeoffWrite(t, filepath.Join(binDir, hiddenBakeoffApp), hiddenBakeoffFakeApp, 0o755)

	cword := run.cword
	if cword == 0 {
		cword = len(run.words) - 1
	}
	compType := run.compType
	if compType == 0 {
		compType = 9
	}

	args := []string{"--noprofile", "--norc", harnessPath, scriptPath, strconv.Itoa(cword), strconv.Itoa(compType)}
	args = append(args, run.words...)

	cmd := exec.Command(bash, args...)
	cmd.Dir = dir
	cmd.Env = []string{
		"PATH=" + binDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"HOME=" + dir,
		"LC_ALL=C",
		"HB_APP=" + hiddenBakeoffApp,
		"HB_REPLY_FILE=" + replyPath,
		"HB_ARGS_FILE=" + argsPath,
		"HB_OUTPUT_FILE=" + outputPath,
		"HB_STDERR_FILE=" + stderrPath,
	}
	if run.noInit {
		cmd.Env = append(cmd.Env, "HB_NO_INIT=1")
	}
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	require.NoErrorf(t, cmd.Run(), "bash failed, stderr: %s", stderr.String())

	reply, err := os.ReadFile(replyPath)
	require.NoError(t, err)

	result := hiddenBakeoffResult{reply: hiddenBakeoffNonEmptyLines(string(reply)), stderr: stderr.String()}
	if recorded, err := os.ReadFile(argsPath); err == nil {
		result.called = true
		result.args = hiddenBakeoffNonEmptyLines(string(recorded))
	}
	return result
}

// The refactored script runs compgen outside of any comment.
func TestHiddenBakeoffBashScriptCallsCompgen(t *testing.T) {
	code := []string{}
	for _, line := range strings.Split(hiddenBakeoffRender(t, hiddenBakeoffApp, "bash"), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			code = append(code, line)
		}
	}
	assert.Regexp(t, regexp.MustCompile(`\bcompgen\b`), strings.Join(code, "\n"))
}

func TestHiddenBakeoffBashRenderHasNoFormatErrors(t *testing.T) {
	out := hiddenBakeoffRender(t, hiddenBakeoffApp, "bash")
	assert.NotContains(t, out, "%!")
	assert.NotContains(t, out, "%[1]s")
}

func TestHiddenBakeoffBashRenderUsesAppName(t *testing.T) {
	out := hiddenBakeoffRender(t, "otherapp", "bash")
	assert.Contains(t, out, "otherapp")
	assert.NotContains(t, out, hiddenBakeoffApp)
}

func TestHiddenBakeoffBashScriptParses(t *testing.T) {
	bash := hiddenBakeoffRequireBash(t)
	path := filepath.Join(t.TempDir(), "completion.bash")
	hiddenBakeoffWrite(t, path, hiddenBakeoffRender(t, hiddenBakeoffApp, "bash"), 0o644)

	out, err := exec.Command(bash, "-n", path).CombinedOutput()
	assert.NoErrorf(t, err, "bash -n: %s", out)
}

func TestHiddenBakeoffBashRegistersCompletionForApp(t *testing.T) {
	bash := hiddenBakeoffRequireBash(t)
	path := filepath.Join(t.TempDir(), "completion.bash")
	hiddenBakeoffWrite(t, path, hiddenBakeoffRender(t, "otherapp", "bash"), 0o644)

	out, err := exec.Command(bash, "--noprofile", "--norc", "-c", `source "$0" && complete -p otherapp`, path).CombinedOutput()
	require.NoErrorf(t, err, "output: %s", out)
	assert.Contains(t, string(out), "-F ")
	assert.True(t, strings.HasSuffix(strings.TrimSpace(string(out)), " otherapp"), "spec: %s", out)
}

func TestHiddenBakeoffBashRegisteredFunctionIsDefined(t *testing.T) {
	bash := hiddenBakeoffRequireBash(t)
	path := filepath.Join(t.TempDir(), "completion.bash")
	hiddenBakeoffWrite(t, path, hiddenBakeoffRender(t, hiddenBakeoffApp, "bash"), 0o644)

	script := `source "$0" && spec="$(complete -p myapp)" && fn="${spec##*-F }" && fn="${fn%% *}" && declare -F "$fn"`
	out, err := exec.Command(bash, "--noprofile", "--norc", "-c", script, path).CombinedOutput()
	assert.NoErrorf(t, err, "output: %s", out)
}

func TestHiddenBakeoffBashFiltersCandidatesByTypedPrefix(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "se"},
		appOutput: "serve\nsetup\nbuild\nhelp\n",
	})
	assert.ElementsMatch(t, []string{"serve", "setup"}, result.names())
}

func TestHiddenBakeoffBashSingleMatchIsTheOnlyReply(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "bu"},
		appOutput: "serve\nsetup\nbuild\nhelp\n",
	})
	assert.Equal(t, []string{"build"}, result.names())
}

func TestHiddenBakeoffBashNoMatchingCandidateGivesNoReply(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "zzz"},
		appOutput: "serve\nsetup\nbuild\n",
	})
	assert.Empty(t, result.names())
}

func TestHiddenBakeoffBashEmptyWordOffersEveryCandidate(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, ""},
		appOutput: "serve\nsetup\nbuild\n",
	})
	assert.ElementsMatch(t, []string{"serve", "setup", "build"}, result.names())
}

func TestHiddenBakeoffBashFullWordStillMatchesLongerCandidates(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "serve"},
		appOutput: "serve\nserver\nsetup\nbuild\n",
	})
	assert.ElementsMatch(t, []string{"serve", "server"}, result.names())
}

func TestHiddenBakeoffBashFiltersFlagCandidates(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "--fl"},
		appOutput: "--flag\n--flat\n--other\n--help\n",
	})
	assert.ElementsMatch(t, []string{"--flag", "--flat"}, result.names())
}

func TestHiddenBakeoffBashMatchesPrefixNotSubstring(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "erv"},
		appOutput: "serve\nervice\nbuild\n",
	})
	assert.Equal(t, []string{"ervice"}, result.names())
}

func TestHiddenBakeoffBashMatchingIsCaseSensitive(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "SE"},
		appOutput: "serve\nSEcret\nbuild\n",
	})
	assert.Equal(t, []string{"SEcret"}, result.names())
}

func TestHiddenBakeoffBashFiltersNestedSubcommandCandidates(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "db", "mi"},
		appOutput: "migrate\nmirror\nseed\n",
	})
	assert.ElementsMatch(t, []string{"migrate", "mirror"}, result.names())
	assert.Equal(t, []string{"db", hiddenBakeoffCompletionFlag}, result.args)
}

func TestHiddenBakeoffBashFiltersOnNameNotDescription(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "se"},
		appOutput: "serve:Run it\nsetup:Prepare it\nbuild:serve the app\n",
	})
	assert.ElementsMatch(t, []string{"serve", "setup"}, result.names())
}

func TestHiddenBakeoffBashKeepsDescriptionsForSeveralMatches(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, ""},
		appOutput: "serve:Run it\nbuild:Bundle it\n",
		compType:  63,
	})
	joined := strings.Join(result.reply, "\n")
	assert.Contains(t, joined, "Run it")
	assert.Contains(t, joined, "Bundle it")
}

func TestHiddenBakeoffBashDoesNotSendPlainWordToApp(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "se"},
		appOutput: "serve\n",
	})
	require.True(t, result.called, "the application must be asked for candidates")
	assert.Equal(t, []string{hiddenBakeoffCompletionFlag}, result.args)
}

func TestHiddenBakeoffBashSendsFlagWordToApp(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "db", "--ve"},
		appOutput: "--verbose\n",
	})
	require.True(t, result.called, "the application must be asked for candidates")
	assert.Equal(t, []string{"db", "--ve", hiddenBakeoffCompletionFlag}, result.args)
}

func TestHiddenBakeoffBashIgnoresWordsAfterCursor(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "se", "extra"},
		cword:     1,
		appOutput: "serve\nbuild\n",
	})
	require.True(t, result.called, "the application must be asked for candidates")
	assert.Equal(t, []string{hiddenBakeoffCompletionFlag}, result.args)
	assert.Equal(t, []string{"serve"}, result.names())
}

func TestHiddenBakeoffBashFiltersWithoutInitCompletion(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, "se"},
		appOutput: "serve\nsetup\nbuild\n",
		noInit:    true,
	})
	assert.ElementsMatch(t, []string{"serve", "setup"}, result.names())
}

func TestHiddenBakeoffBashDiscardsAppStderr(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words:     []string{hiddenBakeoffApp, ""},
		appOutput: "serve\n",
		appStderr: "bakeoff-warning\n",
	})
	assert.Equal(t, []string{"serve"}, result.names())
	assert.NotContains(t, result.stderr, "bakeoff-warning")
}

func TestHiddenBakeoffBashSilentAppGivesNoReply(t *testing.T) {
	result := hiddenBakeoffComplete(t, hiddenBakeoffRun{
		words: []string{hiddenBakeoffApp, "se"},
	})
	assert.Empty(t, result.names())
}

func TestHiddenBakeoffOtherShellScriptsStillRender(t *testing.T) {
	for _, shell := range []string{"zsh", "fish"} {
		out := hiddenBakeoffRender(t, hiddenBakeoffApp, shell)
		assert.Contains(t, out, hiddenBakeoffApp, shell)
		assert.NotContains(t, out, "%!", shell)
	}
	assert.NotEmpty(t, hiddenBakeoffRender(t, hiddenBakeoffApp, "pwsh"))
}
