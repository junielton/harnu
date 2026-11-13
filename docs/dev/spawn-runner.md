# The spawn runner: why `spawn()` blocks the main thread, and where forks happen now (BUG-266)

Harnu's main thread carries keystrokes. After the BUG-261/262 fixes the longest remaining tasks were single
`child_process` spawns: one Your move judge (`claude -p`) held the thread for 374 ms, one git probe for 267 ms.
This page records why, and (once the runner lands) how the code is arranged so it cannot happen again.

## AC-1 — why one spawn costs 100–370 ms

**Finding: the cost is the `fork()` itself.** Node (libuv) creates a child with a plain `fork()`: the calling thread
is blocked until the kernel has copied the parent's page tables and memory map, and the child has `exec`ed.
That work is proportional to what the parent has mapped, and Electron's main process maps a lot. It is not env
sanitizing and not PATH lookup.

### Evidence

1. **The syscall.** `strace -f -e trace=clone,vfork,execve` on the Electron binary running a one-line
   `child_process.spawn('/bin/true')`: `clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD)`.
   No `CLONE_VM`, no `CLONE_VFORK`: a full copy-on-write fork, and the parent waits for the child's `execve`.
2. **The real profile** (packaged v0.3.63-alpha.7434, 90 s, main process; `scripts/dev/spawn-cost/profile-spawn-self-time.cjs`):
   35 `spawn` frames with self time, adding up to ~1.3 s. Baseline ~17–24 ms each (17 of them), and a tail of
   294, 197, 159, 127, 113, 104, 91, 83 ms. Every one is self time in `spawn`, none in JS.
3. **Cost against parent size** (`scripts/dev/spawn-cost/main-cost.cjs`, real Electron main, `git --version`,
   30 calls, ms the calling thread was blocked):

   | main-process RSS | direct `execFile` median / p90 / max | handing the call to a `utilityProcess` |
   | ---------------- | ------------------------------------ | -------------------------------------- |
   | 110 MB           | 7.4–8.0 / 10.0 / 12–27               | 0.1 / 0.1 / 0.3                        |
   | 465 MB           | 9.2 / 12.7 / 19.1                    | 0.1 / 0.1 / 0.2                        |
   | 654 MB           | 14.1 / 17.3 / 27.3                   | 0.0 / 0.1 / 0.1                        |

   Plain Node (what vitest runs on), `execFile('git')` with a live ballast: 165 MB → 11 ms median, 334 MB → 12 ms,
   452 MB → 27 ms median / 39 ms max.

4. **What it is not.** In plain Node at 83 MB: `spawn('git')` 3.2 ms vs `spawn('/usr/bin/git')` 2.0 ms (PATH lookup
   is noise), and an empty `env` saves ~1.5 ms (env handling is noise). Neither grows with parent size.

### What is reproduced and what is not

The median (7–14 ms, rising ~20 ms per GB of RSS, plus a fixed ~7 ms for Electron's many mappings) is
reproduced. The 100–370 ms tail was **not** reproduced in isolation: it only showed in the live app, with 15
sessions streaming, many threads and a busy GC. `fork()` takes the parent's `mmap` lock while it copies, so
any thread that faults or maps memory at that moment queues behind it, and the forking thread waits for the
same lock the other way round. That is a hypothesis consistent with the data, not something this
investigation proved. It does not change the fix: the cost is in the forking process, so the forking process
must not be the main process.

### Decision

The fix is the one AC-2 names for this case: **a small helper process does the forking**. The main thread posts
a message (0.1 ms) and gets the result back as another message. A helper's own fork costs 1–3 ms (it is small),
and no keystroke waits on it.
