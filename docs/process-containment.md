# Run process containment

Harness runs in `spawnLogged` and coordinator verify, evidence setup and evidence
commands use `spawnRun`. Git/GitHub reads and interactive planning retain their
existing subprocess behavior. Commands keep their argv and environment; a shell
is used only when the caller explicitly requests one.

The run owner is a small executable compiled once per coordinator into an
exclusively created temporary directory. Windows uses the .NET Framework C#
compiler installed with Windows; POSIX requires `cc`. Sources ship under
`assets/process-run.cs` and `assets/process-run.c`, including in npm packages.
Compilation or containment setup failure prevents the workload from starting
and reports a warning/failure, rather than starting an unowned workload.

On Windows the owner creates a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, creates the root suspended, assigns it to
the job and only then resumes it. Descendants inherit membership even when
detached or reparented. Breakaway is disabled. Once the root exits, the owner
terminates the job and waits for its active-process count to reach zero before
exiting. Closing the owner also closes its job handle.

On POSIX the workload starts in a new session/process group. The owner kills
the group with `SIGKILL` when the root exits. Linux also uses
`PR_SET_CHILD_SUBREAPER`: orphaned descendants, including `setsid()` and
double-fork daemons, become children of this run's owner. It repeatedly kills
and reaps only its own children until drained. The root remains unreaped during
cleanup, pinning its PID/process-group identity against reuse. Other POSIX
systems get group cleanup and an explicit warning that detached descendants
cannot be accounted for. Linux and Windows provide the full detached-process
guarantee and are the CI platforms.

Timeouts and `abortOn` write a stop request into the run's exclusive control
directory. `killProcessTree` delegates to this request for owned runs; the owner
retains the existing Windows `taskkill /T /F` timeout behavior before job cleanup
(POSIX kills the root with `SIGKILL`). The supervisor stays alive to finish
accounting for descendants. No PID/cwd scans of unrelated host processes are
used. OS cleanup failures warn with the affected root/group/PID. Callers await
the supervisor and stream closure before reading logs, cleaning worktrees or
starting another evidence command.

This owns process lifetime, rather than sandboxing adversarial code or external
services. Killing the coordinator itself and recovering interrupted tasks is
outside #231.

References: [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject),
[Linux subreapers](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).
