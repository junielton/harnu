package cobra_test

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// hiddenApp is a small command tree: root has the persistent flags
// -z/--zero, -o/--one, -t/--third (strings) and -b/--bool (a bool), the
// subcommands "one", "two" (alias "tw") and "parent" (with a "child" below it).
type hiddenApp struct {
	root  *cobra.Command
	two   *cobra.Command
	zero  string
	one   string
	third string
	local string
	opt   string
	bool_ bool
	ran   string
	args  []string
	calls int
}

func newHiddenApp() *hiddenApp {
	app := &hiddenApp{}
	run := func(cmd *cobra.Command, args []string) {
		app.ran = cmd.Name()
		app.args = args
		app.calls++
	}

	app.root = &cobra.Command{Use: "root", Run: run}
	flags := app.root.PersistentFlags()
	flags.StringVarP(&app.zero, "zero", "z", "", "")
	flags.StringVarP(&app.one, "one", "o", "", "")
	flags.StringVarP(&app.third, "third", "t", "", "")
	flags.BoolVarP(&app.bool_, "bool", "b", false, "")
	flags.StringVar(&app.opt, "opt", "", "")
	flags.Lookup("opt").NoOptDefVal = "implicit"

	subOne := &cobra.Command{Use: "one", Run: run}
	app.two = &cobra.Command{Use: "two", Aliases: []string{"tw"}, Long: "hidden-two-long-description", Run: run}
	app.two.Flags().StringVar(&app.local, "local", "", "")
	parent := &cobra.Command{Use: "parent", Run: run}
	child := &cobra.Command{Use: "child", Run: run}
	parent.AddCommand(child)
	app.root.AddCommand(subOne, app.two, parent)
	return app
}

func (app *hiddenApp) execute(args ...string) (string, error) {
	buf := new(bytes.Buffer)
	app.root.SetOut(buf)
	app.root.SetErr(buf)
	app.root.SetArgs(args)
	err := app.root.Execute()
	return buf.String(), err
}

// mustRun executes args and checks which command ran with which positionals.
func (app *hiddenApp) mustRun(t *testing.T, wantCmd string, wantArgs []string, args ...string) {
	t.Helper()
	output, err := app.execute(args...)
	if err != nil {
		t.Fatalf("execute %q: unexpected error: %v\n%s", args, err, output)
	}
	if app.calls != 1 {
		t.Fatalf("execute %q: Run was called %d times, want 1", args, app.calls)
	}
	if app.ran != wantCmd {
		t.Errorf("execute %q: ran command %q, want %q", args, app.ran, wantCmd)
	}
	if len(app.args) != len(wantArgs) || (len(wantArgs) > 0 && !reflect.DeepEqual(app.args, wantArgs)) {
		t.Errorf("execute %q: positional args %q, want %q", args, app.args, wantArgs)
	}
}

func checkFlag(t *testing.T, name, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("flag %s = %q, want %q", name, got, want)
	}
}

func TestHiddenBakeoffFirstShortFlagValueMatchesSubcommand(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "-o", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffFirstLongFlagValueMatchesSubcommand(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "--zero", "two", "--one", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffShortThenLongFlag(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "--one", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffLongThenShortFlag(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "--zero", "two", "-o", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffThreeFlagsFirstCollides(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "-o", "one", "-t", "x", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
	checkFlag(t, "third", app.third, "x")
}

func TestHiddenBakeoffEveryFlagValueCollides(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "-o", "two", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "two")
}

func TestHiddenBakeoffBoolFlagBeforeCollidingValue(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-b", "-z", "two", "-o", "one", "two")
	if !app.bool_ {
		t.Errorf("flag bool = false, want true")
	}
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffPositionalAfterSubcommandIsKept(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", []string{"extra"}, "-z", "two", "-o", "one", "two", "extra")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffPositionalNamedLikeSubcommandIsKept(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", []string{"two"}, "-z", "two", "-o", "one", "two", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffLocalFlagOfSubcommandAfterCollision(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "-o", "one", "two", "--local", "v")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
	checkFlag(t, "local", app.local, "v")
}

func TestHiddenBakeoffTerminatorAfterSubcommand(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", []string{"two"}, "-z", "two", "-o", "one", "two", "--", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffNestedChildNameAsFlagValue(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "child", nil, "-z", "child", "-o", "x", "parent", "child")
	checkFlag(t, "zero", app.zero, "child")
	checkFlag(t, "one", app.one, "x")
}

func TestHiddenBakeoffNestedParentNameAsFlagValue(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "child", nil, "-z", "parent", "-o", "x", "parent", "child")
	checkFlag(t, "zero", app.zero, "parent")
	checkFlag(t, "one", app.one, "x")
}

func TestHiddenBakeoffAliasAsFlagValue(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "tw", "-o", "one", "tw")
	checkFlag(t, "zero", app.zero, "tw")
	checkFlag(t, "one", app.one, "one")
	if got := app.two.CalledAs(); got != "tw" {
		t.Errorf("CalledAs() = %q, want %q", got, "tw")
	}
}

func TestHiddenBakeoffPrefixMatchedSubcommandAsFlagValue(t *testing.T) {
	saved := cobra.EnablePrefixMatching
	cobra.EnablePrefixMatching = true
	defer func() { cobra.EnablePrefixMatching = saved }()

	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "tw", "-o", "one", "tw")
	checkFlag(t, "zero", app.zero, "tw")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffHelpCommandNameAsFlagValue(t *testing.T) {
	app := newHiddenApp()
	output, err := app.execute("-z", "help", "-o", "one", "help", "two")
	if err != nil {
		t.Fatalf("unexpected error: %v\n%s", err, output)
	}
	if !strings.Contains(output, "hidden-two-long-description") {
		t.Errorf("help did not describe the two subcommand, output:\n%s", output)
	}
	if app.calls != 0 {
		t.Errorf("help must not run the command, Run was called %d times", app.calls)
	}
	checkFlag(t, "zero", app.zero, "help")
}

func TestHiddenBakeoffFindKeepsFlagValueAndDropsSubcommand(t *testing.T) {
	app := newHiddenApp()
	cmd, rest, err := app.root.Find([]string{"-z", "two", "-o", "one", "two"})
	if err != nil {
		t.Fatalf("Find: unexpected error: %v", err)
	}
	if cmd != app.two {
		t.Errorf("Find returned command %q, want two", cmd.Name())
	}
	want := []string{"-z", "two", "-o", "one"}
	if !reflect.DeepEqual(rest, want) {
		t.Errorf("Find returned args %q, want %q", rest, want)
	}
}

func TestHiddenBakeoffFindKeepsOrderAroundSubcommand(t *testing.T) {
	app := newHiddenApp()
	cmd, rest, err := app.root.Find([]string{"--zero", "two", "two", "--one", "two", "extra"})
	if err != nil {
		t.Fatalf("Find: unexpected error: %v", err)
	}
	if cmd != app.two {
		t.Errorf("Find returned command %q, want two", cmd.Name())
	}
	want := []string{"--zero", "two", "--one", "two", "extra"}
	if !reflect.DeepEqual(rest, want) {
		t.Errorf("Find returned args %q, want %q", rest, want)
	}
}

func TestHiddenBakeoffCompletionSeesFlagValue(t *testing.T) {
	app := newHiddenApp()
	var gotArgs []string
	var gotZero string
	called := false
	app.two.ValidArgsFunction = func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		called = true
		gotArgs = args
		gotZero = app.zero
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	output, err := app.execute(cobra.ShellCompRequestCmd, "-z", "two", "-o", "one", "two", "")
	if err != nil {
		t.Fatalf("unexpected error: %v\n%s", err, output)
	}
	if !called {
		t.Fatalf("the two subcommand's completion function was not called, output:\n%s", output)
	}
	if len(gotArgs) != 0 {
		t.Errorf("completion got positional args %q, want none", gotArgs)
	}
	checkFlag(t, "zero", gotZero, "two")
}

// Invocations the request lists as working, and neighbouring behavior that
// must stay as it is.

func TestHiddenBakeoffRequestLiteralInvocation(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "one", "-o", "one", "two")
	checkFlag(t, "zero", app.zero, "one")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffSingleFlagStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "two", "two")
	checkFlag(t, "zero", app.zero, "two")
}

func TestHiddenBakeoffEqualsDelimitedStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z=two", "-o=one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffCollidingValueNotFirstStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-z", "one", "-o", "two", "two")
	checkFlag(t, "zero", app.zero, "one")
	checkFlag(t, "one", app.one, "two")
}

func TestHiddenBakeoffSubcommandFirstStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "two", "-z", "two", "-o", "one")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffAttachedShortValueStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-ztwo", "-o", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffBoolFlagDoesNotConsumeSubcommand(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", nil, "-b", "two")
	if !app.bool_ {
		t.Errorf("flag bool = false, want true")
	}
}

func TestHiddenBakeoffOptionalValueFlagDoesNotConsumeSubcommand(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "two", []string{"two"}, "--opt", "two", "two")
	checkFlag(t, "opt", app.opt, "implicit")
}

func TestHiddenBakeoffFlagValuesAloneRunRoot(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "root", nil, "-z", "two", "-o", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "two")
}

func TestHiddenBakeoffTerminatorStopsSubcommandSearch(t *testing.T) {
	app := newHiddenApp()
	app.mustRun(t, "root", []string{"two"}, "-z", "two", "-o", "one", "--", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}

func TestHiddenBakeoffRootPositionalWithArbitraryArgs(t *testing.T) {
	app := newHiddenApp()
	app.root.Args = cobra.ArbitraryArgs
	app.mustRun(t, "root", []string{"other"}, "-z", "two", "other")
	checkFlag(t, "zero", app.zero, "two")
}

func TestHiddenBakeoffFindWithoutSubcommandLeavesArgsAlone(t *testing.T) {
	app := newHiddenApp()
	input := []string{"-z", "two", "-o", "one"}
	cmd, rest, err := app.root.Find(input)
	if err != nil {
		t.Fatalf("Find: unexpected error: %v", err)
	}
	if cmd != app.root {
		t.Errorf("Find returned command %q, want root", cmd.Name())
	}
	if !reflect.DeepEqual(rest, input) {
		t.Errorf("Find returned args %q, want %q", rest, input)
	}
}

func TestHiddenBakeoffTraverseChildrenStillWorks(t *testing.T) {
	app := newHiddenApp()
	app.root.TraverseChildren = true
	app.mustRun(t, "two", nil, "-z", "two", "-o", "one", "two")
	checkFlag(t, "zero", app.zero, "two")
	checkFlag(t, "one", app.one, "one")
}
